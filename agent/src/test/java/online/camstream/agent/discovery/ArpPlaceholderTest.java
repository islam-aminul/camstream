package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * An ARP cache holds placeholders as well as answers, and they look like
 * addresses.
 *
 * Linux writes 00:00:00:00:00:00 for an entry it has not resolved yet. Taken at
 * face value that is not a wrong answer, it is a catastrophic one: every
 * unresolved device on the network collapses onto the one identity
 * "mac-000000000000".
 *
 * Found on a Raspberry Pi, which restarted with a cold ARP cache and
 * re-registered its camera under that identity. The assignment naming the
 * camera's real address then matched nothing, so the agent refused to stream it
 * as an unknown camera — while reporting the same camera as discovered,
 * authenticated and carrying two profiles. Nothing in the logs connected those
 * two facts, and the console showed a camera that was plainly present and
 * plainly would not play.
 */
class ArpPlaceholderTest {

    @Test
    @DisplayName("an unresolved entry is not a hardware address")
    void rejectsTheAllZeroPlaceholder() {
        assertFalse(MacResolver.isUsable("00:00:00:00:00:00"),
                "this is the placeholder that collapsed every device onto one identity");
    }

    @Test
    @DisplayName("broadcast and multicast are not device addresses")
    void rejectsGroupAddresses() {
        assertFalse(MacResolver.isUsable("ff:ff:ff:ff:ff:ff"));
        // The low bit of the first octet is the individual/group flag. No
        // interface uses a group address as its own.
        assertFalse(MacResolver.isUsable("01:00:5e:00:00:fb"), "IPv4 multicast");
        assertFalse(MacResolver.isUsable("33:33:00:00:00:01"), "IPv6 multicast");
    }

    @Test
    @DisplayName("a real camera address is still accepted")
    void keepsRealAddresses() {
        // The camera this was found on.
        assertTrue(MacResolver.isUsable("28:18:fd:f1:e5:be"));
        assertTrue(MacResolver.isUsable("00:eb:d8:d4:61:69"), "a leading zero octet is fine");
        // Locally administered addresses are unusual but legitimately assigned
        // to an interface, so they identify a device perfectly well.
        assertTrue(MacResolver.isUsable("02:42:ac:11:00:02"));
    }

    @Test
    @DisplayName("malformed input is refused rather than half-parsed")
    void rejectsRubbish() {
        assertFalse(MacResolver.isUsable(null));
        assertFalse(MacResolver.isUsable(""));
        assertFalse(MacResolver.isUsable("28:18:fd:f1:e5"));
        assertFalse(MacResolver.isUsable("not a mac"));
    }

    @Test
    @DisplayName("a camera with a placeholder address gets no MAC identity")
    void identityFallsThroughRatherThanCollapsing() {
        // The whole point: identity must fall through to the serial or the
        // address, not to a name shared with every other unresolved device.
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.ipAddress = "192.168.0.113";
        camera.macAddress = "00:00:00:00:00:00";

        assertNull(DiscoveryService.macIdentity(camera));
    }
}
