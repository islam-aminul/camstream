package online.camstream.agent.publish;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class MasterPlaylistTest {

    @Test
    void describesOnlyCodecsItActuallyProduces() {
        assertEquals("avc1.42E01E", MasterPlaylist.rfc6381("h264"));
        assertEquals("hvc1.1.6.L93.B0", MasterPlaylist.rfc6381("hevc"));
        assertEquals("hvc1.1.6.L93.B0", MasterPlaylist.rfc6381("H265"));
        // A wrong CODECS value is worse than none: players use it to reject a
        // rung before fetching it.
        assertNull(MasterPlaylist.rfc6381("mjpeg"));
        assertNull(MasterPlaylist.rfc6381(null));
    }

    @Test
    void prefersTheCamerasDeclaredBitrateOverAGuess() {
        // BANDWIDTH is the peak segment rate, so a declared average is padded.
        assertEquals(3_600_000, MasterPlaylist.estimateBandwidth(1920, 1080, 3000));
        assertEquals(600_000, MasterPlaylist.estimateBandwidth(640, 360, 500));
    }

    @Test
    void fallsBackToAResolutionBasedEstimate() {
        int estimate = MasterPlaylist.estimateBandwidth(1920, 1080, null);
        assertTrue(estimate > 1_000_000 && estimate <= 8_000_000,
                "1080p should land in a plausible range, got " + estimate);
        // Never zero: a rung with BANDWIDTH=0 is chosen first and then stalls.
        assertTrue(MasterPlaylist.estimateBandwidth(160, 120, null) >= 200_000);
    }

    @Test
    void ignoresADeclaredBitrateOfZero() {
        assertTrue(MasterPlaylist.estimateBandwidth(640, 360, 0) >= 200_000);
    }
}
