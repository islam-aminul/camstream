package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What a port scan finds that is not a camera.
 *
 * The sweep knocks on every address on the subnet and keeps whatever answers,
 * which on an ordinary network means the router, a printer, a NAS, and the
 * machine running the agent. They came through the same door as the cameras,
 * so they were offered for approval alongside them - at the site this was
 * written for, the first candidate in the list was 192.168.0.1, the gateway.
 *
 * The line is drawn at the two things a camera must be able to do: answer
 * ONVIF, or hold an RTSP port open. A device that does neither cannot be made
 * into a stream by any credential, and is not worth an operator's attention.
 */
class NotACameraTest {

    private static DiscoveredCamera device(DiscoveredCamera.AuthState state, String note) {
        DiscoveredCamera device = new DiscoveredCamera();
        device.id = "mac-aabbccddeeff";
        device.ipAddress = "192.168.0.1";
        device.authState = state;
        device.note = note;
        return device;
    }

    @Test
    @DisplayName("a device with neither ONVIF nor RTSP is not offered")
    void routerIsDropped() {
        assertTrue(NotACameraTest.dropped(
                device(DiscoveredCamera.AuthState.UNSUPPORTED, "no ONVIF service and no RTSP port open")));
    }

    @Test
    @DisplayName("a camera that only refused its password is still offered")
    void refusedCredentialsAreKept() {
        // This is the case an operator fixes by typing a password. Dropping it
        // would hide the camera they are trying to add.
        assertFalse(dropped(device(DiscoveredCamera.AuthState.NEEDS_CREDENTIALS, "401 from ONVIF")));
    }

    @Test
    @DisplayName("a working camera, and one not yet tried, are both offered")
    void usableDevicesAreKept() {
        assertFalse(dropped(device(DiscoveredCamera.AuthState.AUTHENTICATED, null)));
        assertFalse(dropped(device(DiscoveredCamera.AuthState.UNKNOWN, null)));
    }

    private static boolean dropped(DiscoveredCamera camera) {
        return DiscoveryService.isNotACamera(camera);
    }
}
