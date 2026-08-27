package online.camstream.agent.discovery;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;

import static org.junit.jupiter.api.Assertions.*;

/**
 * What a camera is called, and why the MAC leads.
 *
 * The MAC is the only one of the three candidates the camera cannot get wrong:
 * assigned by the manufacturer, unique by construction, read off the network
 * rather than out of the firmware, and unchanged by a factory reset.
 */
class CameraIdentityTest {

    private static DiscoveredCamera camera(String ip, String mac, String serial) {
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.ipAddress = ip;
        camera.macAddress = mac;
        camera.serialNumber = serial;
        return camera;
    }

    private static void assign(DiscoveredCamera camera) throws Exception {
        Method method = DiscoveryService.class.getDeclaredMethod("assignIdentity", DiscoveredCamera.class);
        method.setAccessible(true);
        method.invoke(null, camera);
    }

    @Test
    void prefersTheMacOverEverythingElse() throws Exception {
        DiscoveredCamera camera = camera("192.168.0.50", "AA:BB:CC:DD:EE:FF", "123456");
        assign(camera);

        assertEquals("mac-aabbccddeeff", camera.id);
        assertTrue(camera.identityStable);
    }

    @Test
    void keepsWhatTheCameraWouldOtherwiseHaveBeenCalled() throws Exception {
        // An approval recorded before the MAC could be read names the serial.
        // Losing that would take a working camera offline until somebody
        // noticed and re-approved it.
        DiscoveredCamera camera = camera("192.168.0.50", "AA:BB:CC:DD:EE:FF", "123456");
        assign(camera);

        assertTrue(camera.alternateIds.contains("sn-123456"), camera.alternateIds.toString());
        assertTrue(camera.alternateIds.contains("ip-192-168-0-50"), camera.alternateIds.toString());
        assertFalse(camera.alternateIds.contains(camera.id), "the identity is not its own alternate");
    }

    @Test
    void fallsBackToTheSerialWhenNoMacIsReadable() throws Exception {
        // Routine: a camera reached across a subnet has no ARP entry here.
        DiscoveredCamera camera = camera("10.20.30.40", null, "SN-9911");
        assign(camera);

        assertEquals("sn-SN-9911", camera.id);
        assertTrue(camera.identityStable);
    }

    @Test
    void fallsBackToTheAddressAndSaysItIsNotStable() throws Exception {
        DiscoveredCamera camera = camera("192.168.0.77", null, null);
        assign(camera);

        assertEquals("ip-192-168-0-77", camera.id);
        assertFalse(camera.identityStable,
                "a DHCP lease renewal renames this camera, and an operator approving it should be told");
    }

    @Test
    void normalisesMacFormatting() throws Exception {
        // ARP output differs between platforms: colons on Linux, hyphens on
        // Windows, and either case. The same camera must not get two names.
        DiscoveredCamera colons = camera("192.168.0.5", "aa:bb:cc:dd:ee:ff", null);
        DiscoveredCamera upper = camera("192.168.0.5", "AA:BB:CC:DD:EE:FF", null);
        assign(colons);
        assign(upper);

        assertEquals(colons.id, upper.id);
    }

    @Test
    void ignoresPunctuationInASerialNumber() throws Exception {
        DiscoveredCamera camera = camera("192.168.0.9", null, " CP/PLUS 12 34 ");
        assign(camera);

        assertEquals("sn-CPPLUS1234", camera.id);
    }
}
