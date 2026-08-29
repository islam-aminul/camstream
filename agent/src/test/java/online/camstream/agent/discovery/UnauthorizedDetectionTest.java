package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Telling "wrong password" apart from "no such path".
 *
 * This is what decides whether the next credential is tried. A camera that
 * answers 401 has the path and dislikes the password, so another password is
 * worth a try. A camera that has no such path will say so to every password
 * there is, and marching a site's whole list past it multiplies the scan for
 * nothing - on devices that often lock an account out after a few failures.
 *
 * The strings are the ones ffmpeg actually emits. It words them differently
 * depending on which method was rejected and which scheme the camera offered,
 * which is why the match is on the parts that do not vary.
 */
class UnauthorizedDetectionTest {

    @Test
    @DisplayName("recognises the refusals ffmpeg reports")
    void recognisesRefusals() {
        assertTrue(RtspProbe.looksUnauthorized(
                "[rtsp @ 000001] method DESCRIBE failed: 401 Unauthorized"));
        assertTrue(RtspProbe.looksUnauthorized(
                "[rtsp @ 000001] Server returned 401 Unauthorized (authorization failed)"));
        assertTrue(RtspProbe.looksUnauthorized(
                "rtsp://x: Server returned 4XX Client Error\n"
                        + "method SETUP failed: 401 Unauthorized"));
    }

    @Test
    @DisplayName("does not read an absent path as a refusal")
    void doesNotMistakeAMissingPath() {
        // 404 means the password was never the problem, and a second one would
        // be five more timeouts for the same answer.
        assertFalse(RtspProbe.looksUnauthorized(
                "[rtsp @ 000001] method DESCRIBE failed: 404 Not Found"));
        assertFalse(RtspProbe.looksUnauthorized(
                "[rtsp @ 000001] Could not find codec parameters for stream 0"));
        assertFalse(RtspProbe.looksUnauthorized("Connection refused"));
        assertFalse(RtspProbe.looksUnauthorized("Connection timed out"));
    }

    @Test
    @DisplayName("says nothing when there is nothing to read")
    void handlesAbsentDiagnostics() {
        assertFalse(RtspProbe.looksUnauthorized(null));
        assertFalse(RtspProbe.looksUnauthorized(""));
    }

    @Test
    @DisplayName("reads the wording whatever case it arrives in")
    void isCaseInsensitive() {
        assertTrue(RtspProbe.looksUnauthorized("METHOD DESCRIBE FAILED: 401 UNAUTHORIZED"));
    }
}
