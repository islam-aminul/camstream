package online.camstream.agent.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves a LAN address to its hardware address.
 *
 * A camera's IP is a DHCP lease and will change; its MAC will not. Identity has
 * to survive that, or an administrator's approval of "the camera in reception"
 * silently transfers to whatever device inherits the address.
 *
 * The ARP cache is only populated for hosts recently talked to, which is why
 * this runs after the port sweep rather than before it.
 */
final class MacResolver {

    private static final Logger log = LoggerFactory.getLogger(MacResolver.class);

    private static final Path LINUX_ARP = Path.of("/proc/net/arp");
    private static final Pattern MAC = Pattern.compile("([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}");
    private static final Pattern IPV4 = Pattern.compile("\\b(\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})\\b");

    private MacResolver() {
    }

    /** IPv4 address to normalised MAC, for every entry currently in the ARP cache. */
    static Map<String, String> arpTable() {
        Map<String, String> table = readLinuxArp();
        if (table.isEmpty()) {
            table = readArpCommand();
        }
        return table;
    }

    /** Linux exposes the cache as a file, which avoids spawning a process. */
    private static Map<String, String> readLinuxArp() {
        Map<String, String> table = new LinkedHashMap<>();
        if (!Files.isReadable(LINUX_ARP)) {
            return table;
        }
        try {
            for (String line : Files.readAllLines(LINUX_ARP, StandardCharsets.UTF_8)) {
                if (line.startsWith("IP address")) {
                    continue;
                }
                String[] fields = line.trim().split("\\s+");
                // Field 2 is Flags. An entry the kernel has not resolved yet is
                // listed with flags 0x0 and a hardware address of all zeros: a
                // placeholder for an address in flight, not an answer. ATF_COM
                // (0x2) is the bit that says the entry is complete.
                if (fields.length >= 4 && MAC.matcher(fields[3]).matches() && isComplete(fields[1])) {
                    put(table, fields[0], fields[3]);
                }
            }
        } catch (Exception e) {
            log.debug("could not read {}: {}", LINUX_ARP, e.toString());
        }
        return table;
    }

    /** Windows: parse `arp -a`, whose columns differ from the Linux file. */
    private static Map<String, String> readArpCommand() {
        Map<String, String> table = new LinkedHashMap<>();
        try {
            Process process = new ProcessBuilder("arp", "-a").redirectErrorStream(true).start();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    Matcher mac = MAC.matcher(line);
                    Matcher ip = IPV4.matcher(line);
                    if (mac.find() && ip.find()) {
                        put(table, ip.group(1), mac.group());
                    }
                }
            }
            if (!process.waitFor(5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.debug("arp -a unavailable: {}", e.toString());
        }
        return table;
    }

    /**
     * Nudges the ARP cache for a host we have not spoken to.
     * A failed reachability probe still usually leaves an entry behind.
     */
    static void prime(String host) {
        try {
            InetAddress.getByName(host).isReachable(200);
        } catch (Exception e) {
            // The side effect is what matters, not the answer.
        }
    }

    /** Lower-case, colon-separated — one spelling so comparisons work. */
    private static String normalise(String mac) {
        return mac.replace('-', ':').toLowerCase(Locale.ROOT);
    }

    /** Whether a /proc/net/arp flags field marks the entry as resolved. */
    private static boolean isComplete(String flags) {
        try {
            return (Integer.decode(flags) & 0x2) != 0;
        } catch (NumberFormatException e) {
            // An unfamiliar format should not silently drop every entry.
            return true;
        }
    }

    /** Records a sighting, unless the address cannot belong to a real device. */
    private static void put(Map<String, String> table, String ip, String mac) {
        String normalised = normalise(mac);
        if (isUsable(normalised)) {
            table.put(ip, normalised);
        } else {
            log.debug("ignoring hardware address {} for {}: not a device address", normalised, ip);
        }
    }

    /**
     * Whether an address can actually identify a device.
     *
     * An ARP cache holds placeholders as well as answers, and they look like
     * addresses: Linux writes 00:00:00:00:00:00 for an entry it has not
     * resolved yet, and other platforms show incomplete entries too.
     *
     * Taken at face value that is not merely a wrong answer, it is a
     * catastrophic one, because every unresolved device on the network
     * collapses onto the single identity "mac-000000000000". A Raspberry Pi
     * that restarted with a cold ARP cache re-registered its camera under that
     * identity, so the assignment naming the camera's real address matched
     * nothing and the agent refused to stream it as an unknown camera - while
     * simultaneously reporting that same camera as discovered, authenticated
     * and carrying two profiles. Nothing in the logs connected the two.
     *
     * Broadcast and multicast are rejected on the same grounds: no interface
     * uses one as its own address, so seeing one means the entry describes
     * something other than the device that was asked about.
     */
    static boolean isUsable(String mac) {
        if (mac == null || !MAC.matcher(mac).matches()) {
            return false;
        }
        String hex = mac.replace(":", "").replace("-", "");
        if (hex.chars().allMatch(c -> c == '0') || hex.equalsIgnoreCase("ffffffffffff")) {
            return false;
        }
        // The low bit of the first octet is the individual/group flag; a group
        // address is a multicast destination, never a sender's own address.
        return (Integer.parseInt(hex.substring(0, 2), 16) & 1) == 0;
    }
}
