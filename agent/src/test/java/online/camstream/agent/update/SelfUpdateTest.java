package online.camstream.agent.update;

import online.camstream.agent.update.SelfUpdate.Decision;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The rules an agent follows before replacing its own program.
 *
 * There is no second chance here. If the new jar does not start there is
 * nothing left running to notice, nothing to put the old one back, and the
 * site is dark until somebody drives to it. So these are tested first and
 * separately from the downloading.
 */
class SelfUpdateTest {

    private static final String GOOD_URL =
            "https://camstream-live-1234.s3.ap-south-1.amazonaws.com/downloads/agent.zip?X-Amz-Signature=x";

    @Test
    @DisplayName("takes a build it is not already running")
    void takesANewBuild() {
        assertEquals(Decision.UPDATE, SelfUpdate.decide("0.1.0", "0.2.0", GOOD_URL));
    }

    @Test
    @DisplayName("does nothing when it is already that build")
    void skipsTheCurrentBuild() {
        // Restarting a site's agents to install what they are running is an
        // outage for no reason.
        assertEquals(Decision.ALREADY_CURRENT, SelfUpdate.decide("0.1.0", "0.1.0", GOOD_URL));
    }

    @Test
    @DisplayName("allows a downgrade, because rolling back is the point")
    void allowsRollback() {
        // The situation where remote update matters most is a bad build. An
        // agent that only ever moves forward cannot help with it.
        assertEquals(Decision.UPDATE, SelfUpdate.decide("0.2.0", "0.1.0", GOOD_URL));
    }

    @Test
    @DisplayName("refuses an instruction that does not say what or where")
    void refusesIncompleteInstructions() {
        assertEquals(Decision.MALFORMED, SelfUpdate.decide("0.1.0", null, GOOD_URL));
        assertEquals(Decision.MALFORMED, SelfUpdate.decide("0.1.0", "", GOOD_URL));
        assertEquals(Decision.MALFORMED, SelfUpdate.decide("0.1.0", "0.2.0", null));
        assertEquals(Decision.MALFORMED, SelfUpdate.decide("0.1.0", "0.2.0", "  "));
    }

    @Test
    @DisplayName("refuses to be pointed at somewhere else entirely")
    void refusesUntrustedSources() {
        // The instruction arrives on a topic only this agent's certificate may
        // be published to, so it is authenticated - but "fetch and execute
        // whatever is at this address" is a capability worth not having.
        assertEquals(Decision.REFUSED, SelfUpdate.decide("0.1.0", "0.2.0",
                "https://evil.example.com/agent.zip"));
        assertEquals(Decision.REFUSED, SelfUpdate.decide("0.1.0", "0.2.0",
                "http://camstream-live.s3.ap-south-1.amazonaws.com/agent.zip"));
        assertEquals(Decision.REFUSED, SelfUpdate.decide("0.1.0", "0.2.0",
                "https://s3.amazonaws.com.evil.example.com/agent.zip"));
    }

    @Test
    @DisplayName("refuses a version string that is really a path or a command")
    void refusesStrangeVersions() {
        assertEquals(Decision.REFUSED, SelfUpdate.decide("0.1.0", "../../etc/passwd", GOOD_URL));
        assertEquals(Decision.REFUSED, SelfUpdate.decide("0.1.0", "0.2.0; rm -rf /", GOOD_URL));
        assertEquals(Decision.REFUSED, SelfUpdate.decide("0.1.0", "latest", GOOD_URL));
    }

    @Test
    @DisplayName("accepts the version shapes this project actually publishes")
    void acceptsRealVersions() {
        for (String version : new String[] { "0.1.0", "1.2", "1.2.3.4", "0.1.0-rc.1", "2" }) {
            assertTrue(SelfUpdate.isPlausibleVersion(version), version);
        }
    }

    @Test
    @DisplayName("treats a truncated download as no download")
    void rejectsATruncatedBundle() {
        // A proxy returning an error page is a few hundred bytes, and unpacking
        // it over the running jar is the one outcome with no way back.
        assertFalse(SelfUpdate.isPlausibleSize(0));
        assertFalse(SelfUpdate.isPlausibleSize(4096));
        assertTrue(SelfUpdate.isPlausibleSize(30L * 1024 * 1024));
    }

    @Test
    @DisplayName("asks for a restart in a way both service managers honour")
    void restartCodeIsNonZero() {
        // systemd restarts on any exit; WinSW restarts on failure. Zero would
        // stop the Windows service and leave a new agent installed and dead.
        assertTrue(SelfUpdate.RESTART_EXIT_CODE != 0);
    }
}
