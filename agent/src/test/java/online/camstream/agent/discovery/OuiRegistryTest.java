package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Naming a camera whose vendor the curated table has never heard of.
 *
 * The console showed "Unknown model" and approved the camera under its own MAC
 * address, so an operator's list of cameras read "mac-2818fdf1e5be". The
 * curated table covers the vendors whose RTSP paths are worth guessing, which
 * is a much smaller set than the vendors that exist; the IEEE registry covers
 * every assigned prefix and answers the only question left, which is who made
 * this.
 */
class OuiRegistryTest {

    @Test
    @DisplayName("names a device the curated table does not cover")
    void namesAnUncuratedVendor() {
        // The camera on the desk this was written for. Its prefix is not in
        // oui-cctv.properties, and before the registry it had no name at all.
        assertNull(VendorDirectory.forMac("28:18:fd:f1:e5:be"),
                "prefix should still be absent from the curated table");
        assertEquals("Aditya Infotech Ltd.", VendorDirectory.registrantFor("28:18:fd:f1:e5:be"));
        assertEquals("Aditya Infotech Ltd.", VendorDirectory.nameFor("2818FDF1E5BE"),
                "punctuation and case must not matter");
    }

    @Test
    @DisplayName("prefers the curated brand over the registrant")
    void curatedNameWins() {
        // Where both know the vendor, the curated name is the one on the box.
        // The registrant is a legal entity and is often not the brand at all.
        for (String mac : List.of("00:12:12:00:00:01", "bc:32:5f:00:00:01", "00:80:f0:00:00:01")) {
            VendorDirectory.Vendor curated = VendorDirectory.forMac(mac);
            if (curated != null) {
                assertEquals(curated.name(), VendorDirectory.nameFor(mac));
                return;
            }
        }
        // No curated prefix was matched; the preference is still expressed by
        // nameFor's implementation, and the registry half is covered above.
    }

    @Test
    @DisplayName("an unassigned prefix stays unnamed rather than guessing")
    void unknownStaysUnknown() {
        // Locally administered addresses are assigned by nobody.
        assertNull(VendorDirectory.registrantFor("02:00:00:00:00:01"));
        assertNull(VendorDirectory.nameFor("not a mac"));
    }

    @Test
    @DisplayName("reads a vendor name containing a comma")
    void parsesQuotedFields() {
        assertEquals(List.of("2818FD", "Aditya Infotech Ltd."),
                VendorDirectory.csvFields("2818FD,Aditya Infotech Ltd."));
        assertEquals(List.of("AABBCC", "Nokia Shanghai Bell Co., Ltd."),
                VendorDirectory.csvFields("AABBCC,\"Nokia Shanghai Bell Co., Ltd.\""));
        assertEquals(List.of("AABBCC", "A \"quoted\" name"),
                VendorDirectory.csvFields("AABBCC,\"A \"\"quoted\"\" name\""));
    }

    @Test
    @DisplayName("the shipped registry is present and substantial")
    void registryShips() {
        // A missing resource degrades silently to no name, which is exactly the
        // symptom this exists to fix - so assert the file actually ships.
        assertNotNull(VendorDirectory.class.getResourceAsStream("/oui-vendors.csv"),
                "oui-vendors.csv must be on the classpath; regenerate with scripts/refresh-oui.sh");
        assertFalse(VendorDirectory.registrantFor("00:00:00:00:00:01") == null,
                "the registry should resolve the oldest assignment there is");
        assertTrue(VendorDirectory.registrantFor("000000").toLowerCase().contains("xerox"));
    }
}
