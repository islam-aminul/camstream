package online.camstream.agent.discovery;

import online.camstream.agent.discovery.VendorDirectory.Vendor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Identifying a device from the three bytes the IEEE assigned its maker.
 *
 * The point is not the label in the console, though that helps. It is that
 * knowing the vendor turns a walk through every known RTSP path into a walk
 * through four, and tells the scanner how that vendor's recorders number their
 * channels.
 */
class VendorDirectoryTest {

    @Test
    @DisplayName("recognises a vendor whatever notation the address arrives in")
    void normalisesEveryNotation() {
        // ARP gives one form, ONVIF another, a camera's own web page a third.
        for (String mac : new String[] {
                "44:19:B6:11:22:33", "44-19-B6-11-22-33", "4419b6112233", "4419B6.112233" }) {
            Vendor vendor = VendorDirectory.forMac(mac);
            assertNotNull(vendor, mac);
            assertEquals("Hikvision", vendor.name(), mac);
        }
    }

    @Test
    @DisplayName("an unknown prefix is an ordinary answer, not a failure")
    void unknownPrefixIsNull() {
        // Which means the generic path list, exactly as before this existed.
        assertNull(VendorDirectory.forMac("02:00:00:00:00:01"));
        assertNull(VendorDirectory.forMac(null));
        assertNull(VendorDirectory.forMac("xyz"));
    }

    @Test
    @DisplayName("carries the paths that vendor actually serves")
    void knowsVendorPaths() {
        Vendor dahua = VendorDirectory.forMac("3C:1A:0D:00:00:01");
        assertNotNull(dahua);
        assertTrue(dahua.paths().stream().anyMatch(p -> p.contains("realmonitor")),
                dahua.paths().toString());
    }

    @Test
    @DisplayName("matches a manufacturer the camera named over ONVIF")
    void matchesByName() {
        assertEquals("Dahua", VendorDirectory.byName("Dahua Technology").name());
        assertEquals("Hikvision", VendorDirectory.byName("HIKVISION").name());
        assertNull(VendorDirectory.byName("A Brand Nobody Has Heard Of"));
        assertNull(VendorDirectory.byName(null));
    }

    @Test
    @DisplayName("knows which vendors number recorder channels, and which do not")
    void knowsWhoEnumerates() {
        assertTrue(VendorDirectory.forMac("44:19:B6:00:00:01").enumeratesChannels());
        // A vendor with no recorder scheme must not be walked: the paths would
        // be invented and every probe a timeout.
        assertFalse(VendorDirectory.forMac("00:40:8C:00:00:01").enumeratesChannels());
    }

    @Test
    @DisplayName("fills in the numbering scheme each vendor actually uses")
    void resolvesChannelPlaceholders() {
        // Hikvision counts channel 3's main stream as 301 and its sub as 302.
        Vendor hik = VendorDirectory.forMac("44:19:B6:00:00:01");
        assertEquals("/Streaming/Channels/301",
                VendorDirectory.resolveChannel(hik.nvrMainPattern(), 3));
        assertEquals("/Streaming/Channels/302",
                VendorDirectory.resolveChannel(hik.nvrSubPattern(), 3));

        // Dahua numbers the channel directly and picks the stream separately.
        Vendor dahua = VendorDirectory.forMac("3C:1A:0D:00:00:01");
        assertEquals("/cam/realmonitor?channel=7&subtype=0",
                VendorDirectory.resolveChannel(dahua.nvrMainPattern(), 7));

        // Reolink zero-pads.
        Vendor reolink = VendorDirectory.forMac("EC:71:DB:00:00:01");
        assertEquals("/h264Preview_04_main",
                VendorDirectory.resolveChannel(reolink.nvrMainPattern(), 4));
    }

    @Test
    @DisplayName("resolving nothing yields nothing")
    void resolvesNullSafely() {
        assertNull(VendorDirectory.resolveChannel(null, 1));
    }
}
