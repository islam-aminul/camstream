package online.camstream.agent.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;

/**
 * Who made a device, from the first three bytes of its hardware address.
 *
 * The IEEE assigns those three bytes — the OUI — to a manufacturer, so a MAC
 * names the vendor without asking the device anything. That matters twice over
 * here. It gives an operator a name to recognise in a list of numbers, and it
 * tells the scanner which RTSP paths are worth trying, which turns a walk
 * through every known path into a walk through four.
 *
 * The table is deliberately partial: CCTV vendors only, held as a resource so
 * it can grow without a code change. An unknown prefix is an ordinary outcome
 * and means the generic paths are used, exactly as before this existed.
 */
public final class VendorDirectory {

    private static final Logger log = LoggerFactory.getLogger(VendorDirectory.class);
    private static final String RESOURCE = "/oui-cctv.properties";

    /** What is known about one manufacturer. */
    public record Vendor(String key, String name, List<String> paths,
                         String nvrMainPattern, String nvrSubPattern) {

        /** Whether this vendor's recorders have a known channel scheme. */
        public boolean enumeratesChannels() {
            return nvrMainPattern != null && !nvrMainPattern.isBlank();
        }
    }

    private static final Map<String, Vendor> BY_PREFIX = new HashMap<>();

    static {
        load();
    }

    private VendorDirectory() {
    }

    private static void load() {
        Properties props = new Properties();
        try (InputStream in = VendorDirectory.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                log.warn("no vendor table on the classpath; every device will be unidentified");
                return;
            }
            props.load(in);
        } catch (Exception e) {
            log.warn("could not read the vendor table: {}", e.toString());
            return;
        }

        Map<String, Vendor> byKey = new HashMap<>();
        for (String name : props.stringPropertyNames()) {
            if (!name.startsWith("vendor.") || !name.endsWith(".name")) {
                continue;
            }
            String key = name.substring("vendor.".length(), name.length() - ".name".length());
            String nvr = props.getProperty("vendor." + key + ".nvr", "").trim();
            List<String> patterns = split(nvr);
            byKey.put(key, new Vendor(
                    key,
                    props.getProperty(name, key).trim(),
                    split(props.getProperty("vendor." + key + ".paths", "")),
                    patterns.isEmpty() ? null : patterns.get(0),
                    patterns.size() > 1 ? patterns.get(1) : null));
        }

        for (String name : props.stringPropertyNames()) {
            if (!name.startsWith("oui.")) {
                continue;
            }
            String prefix = normalise(name.substring("oui.".length()));
            Vendor vendor = byKey.get(props.getProperty(name).trim());
            if (prefix != null && vendor != null) {
                BY_PREFIX.put(prefix, vendor);
            }
        }
        log.debug("vendor table holds {} OUI prefixes across {} vendors",
                BY_PREFIX.size(), byKey.size());
    }

    private static List<String> split(String value) {
        List<String> parts = new ArrayList<>();
        for (String part : value.split(",")) {
            if (!part.isBlank()) {
                parts.add(part.trim());
            }
        }
        return List.copyOf(parts);
    }

    /**
     * The first six hex digits of a hardware address, however it was punctuated.
     *
     * MACs arrive from ARP, from ONVIF and from a camera's own web page in at
     * least three notations, and the caller should not have to care which.
     */
    static String normalise(String macOrPrefix) {
        if (macOrPrefix == null) {
            return null;
        }
        String hex = macOrPrefix.replaceAll("[^0-9A-Fa-f]", "").toUpperCase(Locale.ROOT);
        return hex.length() >= 6 ? hex.substring(0, 6) : null;
    }

    /** The manufacturer of a device with this hardware address, if it is known. */
    public static Vendor forMac(String mac) {
        String prefix = normalise(mac);
        return prefix == null ? null : BY_PREFIX.get(prefix);
    }

    /** The manufacturer by name, for a device that told us over ONVIF. */
    public static Vendor byName(String manufacturer) {
        if (manufacturer == null || manufacturer.isBlank()) {
            return null;
        }
        String wanted = manufacturer.toLowerCase(Locale.ROOT);
        for (Vendor vendor : BY_PREFIX.values()) {
            if (wanted.contains(vendor.key()) || wanted.contains(vendor.name().toLowerCase(Locale.ROOT))) {
                return vendor;
            }
        }
        return null;
    }

    /**
     * Fills in a channel number.
     *
     * The placeholders are the numbering schemes recorders actually use.
     * Hikvision counts channel one's main stream as 101 and its sub as 102;
     * Dahua numbers channels directly and picks the stream with a separate
     * parameter; Reolink zero-pads. One line of table per vendor describes the
     * whole scheme, which is why these are patterns rather than code.
     */
    public static String resolveChannel(String pattern, int channel) {
        if (pattern == null) {
            return null;
        }
        return pattern
                .replace("{channel*100+1}", String.valueOf(channel * 100 + 1))
                .replace("{channel*100+2}", String.valueOf(channel * 100 + 2))
                .replace("{channel+100}", String.valueOf(channel + 100))
                .replace("{channel:02}", String.format("%02d", channel))
                .replace("{channel}", String.valueOf(channel));
    }
}
