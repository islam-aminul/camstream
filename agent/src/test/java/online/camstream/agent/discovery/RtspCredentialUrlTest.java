package online.camstream.agent.discovery;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.junit.jupiter.api.Test;

import java.net.URI;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Credentials have to survive the trip into an RTSP URL intact.
 *
 * They did not. URLEncoder was used to escape them, which is HTML form
 * encoding rather than URI encoding, so a space became '+' and a '+' became a
 * space. The camera then answered 401, the agent read that as a refusal and
 * backed off for five minutes advising the operator to check the credentials —
 * which were right all along.
 */
class RtspCredentialUrlTest {

    private static final String BASE = "rtsp://192.168.0.113:554/stream1";

    private static String withCredentials(String user, String password) {
        return DiscoveryService.withCredentials(BASE, new Credential(user, password));
    }

    /**
     * What a camera actually receives, after the URL is parsed again.
     *
     * URI.getUserInfo() already percent-decodes per RFC 3986, which is the
     * whole point — running URLDecoder over it as well would form-decode a
     * second time and turn a legitimate '+' back into a space, repeating the
     * exact mistake under test.
     */
    private static String[] decoded(String url) {
        String userInfo = URI.create(url).getUserInfo();
        int split = userInfo.indexOf(':');
        return new String[] { userInfo.substring(0, split), userInfo.substring(split + 1) };
    }

    @Test
    void carriesAnOrdinaryCredentialUnchanged() {
        assertEquals("rtsp://admin:hunter2@192.168.0.113:554/stream1", withCredentials("admin", "hunter2"));
    }

    @Test
    void aSpaceSurvivesAsASpace() {
        // The original bug, in one line: URLEncoder made this "my+pass+word".
        String url = withCredentials("admin", "my pass word");
        assertFalse(url.contains("+"), "a space must not become '+': " + url);
        assertTrue(url.contains("%20"), "a space must be percent-encoded: " + url);
        assertArrayEquals(new String[] {"admin", "my pass word"}, decoded(url));
    }

    @Test
    void aPlusSurvivesAsAPlus() {
        // The same bug from the other side: '+' was passed through literally
        // and the camera decoded it back to a space.
        String url = withCredentials("admin", "pa+ss");
        assertArrayEquals(new String[] {"admin", "pa+ss"}, decoded(url));
    }

    @Test
    void charactersThatWouldOtherwiseEndTheComponentAreEscaped() {
        // '@' would terminate the userinfo and ':' would split it, so a
        // password containing either must not appear raw.
        String url = withCredentials("admin", "p@ss:word/x?y#z");
        assertEquals("192.168.0.113", URI.create(url).getHost(), "the host must still parse: " + url);
        assertEquals(554, URI.create(url).getPort());
        assertEquals("/stream1", URI.create(url).getPath());
        assertArrayEquals(new String[] {"admin", "p@ss:word/x?y#z"}, decoded(url));
    }

    @Test
    void nonAsciiIsCarriedAsUtf8() {
        String url = withCredentials("admin", "pässwörd");
        assertArrayEquals(new String[] {"admin", "pässwörd"}, decoded(url));
    }

    @Test
    void leavesAUrlThatAlreadyCarriesCredentialsAlone() {
        String already = "rtsp://someone:else@192.168.0.113:554/stream1";
        assertEquals(already, DiscoveryService.withCredentials(already, new Credential("admin", "hunter2")));
    }

    @Test
    void returnsTheUrlUntouchedWhenThereIsNoUsername() {
        assertEquals(BASE, DiscoveryService.withCredentials(BASE, new Credential("", "hunter2")));
        assertEquals(BASE, DiscoveryService.withCredentials(BASE, new Credential(null, "hunter2")));
    }

    @Test
    void toleratesAnEmptyPassword() {
        // Cameras shipped with a blank password are common enough to meet.
        String url = withCredentials("admin", "");
        assertEquals("rtsp://admin:@192.168.0.113:554/stream1", url);
    }
}
