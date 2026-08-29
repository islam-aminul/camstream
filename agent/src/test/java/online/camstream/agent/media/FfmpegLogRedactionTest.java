package online.camstream.agent.media;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * ffmpeg echoes the input URL in several error paths, and that URL carries the
 * camera's password. The credential design turns on plaintext existing in two
 * places — the administrator's browser tab and the agent's memory — so the
 * journal quietly becoming a third undermines the claim rather than the
 * mechanism.
 */
class FfmpegLogRedactionTest {

    @Test
    void stripsCredentialsFromAnEchoedUrl() {
        assertEquals(
            "Error opening input file rtsp://<redacted>@192.168.0.113:554/stream1.",
            FfmpegHls.redact("Error opening input file rtsp://admin:hunter2@192.168.0.113:554/stream1."));
    }

    @Test
    void leavesAUrlWithoutCredentialsAlone() {
        String line = "[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized";
        assertEquals(line, FfmpegHls.redact(line));
        assertEquals("opening rtsp://192.168.0.113:554/stream1",
                FfmpegHls.redact("opening rtsp://192.168.0.113:554/stream1"));
    }

    @Test
    void handlesPasswordsContainingAwkwardCharacters() {
        // Percent-encoded by the time it reaches a URL, but the redaction must
        // not depend on that: an escaped colon or slash is still userinfo.
        String redacted = FfmpegHls.redact("rtsp://admin:p%40ss%3Aword@10.0.0.5/live");
        assertFalse(redacted.contains("p%40ss"), redacted);
        assertTrue(redacted.startsWith("rtsp://<redacted>@10.0.0.5/live"), redacted);
    }

    @Test
    void redactsEveryUrlOnOneLine() {
        String redacted = FfmpegHls.redact(
                "retry rtsp://a:b@10.0.0.1/x then rtsp://c:d@10.0.0.2/y");
        assertFalse(redacted.contains(":b@"), redacted);
        assertFalse(redacted.contains(":d@"), redacted);
    }

    @Test
    void copesWithNothingToRedact() {
        assertNull(FfmpegHls.redact(null));
        assertEquals("", FfmpegHls.redact(""));
    }
}
