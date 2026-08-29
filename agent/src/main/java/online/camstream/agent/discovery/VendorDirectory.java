package online.camstream.agent.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
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

    /**
     * The IEEE registry, trimmed to two columns by scripts/refresh-oui.sh.
     *
     * The curated table above knows a handful of vendors well enough to guess
     * their RTSP paths. This knows who owns every assigned prefix and nothing
     * else, which is all that is needed to stop a camera being called
     * "Unknown model" in a list. Loaded on first miss rather than at start-up:
     * a site of recognised cameras never pays for it.
     */
    private static final String REGISTRY = "/oui-vendors.csv";

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

    private static volatile Map<String, String> registrants;

    /**
     * Every assigned OUI and who holds it, read once and kept.
     *
     * Around forty thousand entries and a megabyte on disk. That is worth
     * saying out loud, because the original table was deliberately partial to
     * avoid exactly this - but a partial table answers "who made this" with
     * silence for most of the market, and silence is what put a MAC address in
     * front of the operator where a name belonged.
     */
    private static Map<String, String> registrants() {
        Map<String, String> loaded = registrants;
        if (loaded != null) {
            return loaded;
        }
        synchronized (VendorDirectory.class) {
            if (registrants != null) {
                return registrants;
            }
            Map<String, String> table = new HashMap<>();
            try (InputStream in = VendorDirectory.class.getResourceAsStream(REGISTRY)) {
                if (in == null) {
                    log.warn("no IEEE OUI registry on the classpath; unrecognised devices stay unnamed");
                } else {
                    read(new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)), table);
                    log.debug("IEEE OUI registry holds {} assignments", table.size());
                }
            } catch (Exception e) {
                // An unreadable table costs a nicer name, nothing else.
                log.warn("could not read the IEEE OUI registry: {}", e.toString());
            }
            registrants = Map.copyOf(table);
            return registrants;
        }
    }

    private static void read(BufferedReader reader, Map<String, String> into) throws java.io.IOException {
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isBlank() || line.charAt(0) == '#') {
                continue;
            }
            List<String> fields = csvFields(line);
            if (fields.size() < 2) {
                continue;
            }
            String prefix = normalise(fields.get(0));
            String name = fields.get(1).trim();
            if (prefix != null && !name.isEmpty() && !name.equalsIgnoreCase("organisation")) {
                into.put(prefix, name);
            }
        }
    }

    /** A CSV row, honouring the quoting the generator emits for names with commas. */
    static List<String> csvFields(String line) {
        List<String> fields = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (quoted) {
                if (c != '"') {
                    field.append(c);
                } else if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    field.append('"');
                    i++;
                } else {
                    quoted = false;
                }
            } else if (c == '"') {
                quoted = true;
            } else if (c == ',') {
                fields.add(field.toString());
                field.setLength(0);
            } else {
                field.append(c);
            }
        }
        fields.add(field.toString());
        return fields;
    }

    /**
     * Who the IEEE says owns this address, for a device the curated table
     * does not recognise.
     *
     * This is the registrant, which is not always the brand on the box -
     * "Aditya Infotech" makes the cameras sold as CP PLUS. It is still a name
     * an operator can look up, which a MAC address is not.
     */
    public static String registrantFor(String mac) {
        String prefix = normalise(mac);
        return prefix == null ? null : registrants().get(prefix);
    }

    /**
     * The best name available for a device: the curated brand where there is
     * one, the IEEE registrant otherwise, and null when even that is unknown.
     */
    public static String nameFor(String mac) {
        Vendor vendor = forMac(mac);
        return vendor != null ? vendor.name() : registrantFor(mac);
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
