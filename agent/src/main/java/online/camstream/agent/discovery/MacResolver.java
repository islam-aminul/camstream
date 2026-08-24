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
                if (fields.length >= 4 && MAC.matcher(fields[3]).matches()) {
                    table.put(fields[0], normalise(fields[3]));
                }
            }
        } catch (Exception e) {
            log.debug("could not read {}: {}", LINUX_ARP, e.toString());
        }
        return table;
    }

    /** Windows and macOS: parse `arp -a`, whose columns differ per platform. */
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
                        table.put(ip.group(1), normalise(mac.group()));
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
}
