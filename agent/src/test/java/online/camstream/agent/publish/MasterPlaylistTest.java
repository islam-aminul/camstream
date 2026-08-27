package online.camstream.agent.publish;

import online.camstream.agent.config.StreamProfile;
import org.junit.jupiter.api.Test;

import java.util.List;

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
    void replacesBitratesThatFailToDistinguishTheRungs() {
        // A real camera declared 2048 kbps for both its 1080p and its 640x360
        // profile. Equal BANDWIDTH values leave a player unable to choose.
        List<MasterPlaylist.Rung> reported = List.of(
                new MasterPlaylist.Rung(StreamProfile.MAIN, "main/index.m3u8", 1920, 1080, 2457600, "h264"),
                new MasterPlaylist.Rung(StreamProfile.SUB, "sub/index.m3u8", 640, 360, 2457600, "h264"));

        List<MasterPlaylist.Rung> fixed = MasterPlaylist.discriminate(reported);
        assertNotEquals(fixed.get(0).bandwidthBps(), fixed.get(1).bandwidthBps(),
                "rungs must be distinguishable");

        int main = fixed.stream().filter(r -> r.height() == 1080).findFirst().orElseThrow().bandwidthBps();
        int sub = fixed.stream().filter(r -> r.height() == 360).findFirst().orElseThrow().bandwidthBps();
        assertTrue(main > sub, "1080p must advertise more bandwidth than 360p");
    }

    @Test
    void leavesCodecAlternativesAlone() {
        // The same camera published as HEVC and as transcoded H.264 is two
        // options for different browsers, not two steps of a ladder — and
        // re-estimating from resolution would make them identical anyway.
        List<MasterPlaylist.Rung> alternatives = List.of(
                new MasterPlaylist.Rung(StreamProfile.SUB, "sub/index.m3u8", 640, 360, 691200, "hevc"),
                new MasterPlaylist.Rung(StreamProfile.SUB, "sub-h264/index.m3u8", 640, 360, 691200, "h264"));
        assertEquals(alternatives, MasterPlaylist.discriminate(alternatives));
    }

    @Test
    void keepsDeclaredBitratesWhenTheyAlreadyDiffer() {
        List<MasterPlaylist.Rung> reported = List.of(
                new MasterPlaylist.Rung(StreamProfile.MAIN, "main/index.m3u8", 1920, 1080, 4000000, "h264"),
                new MasterPlaylist.Rung(StreamProfile.SUB, "sub/index.m3u8", 640, 360, 600000, "h264"));
        assertEquals(reported, MasterPlaylist.discriminate(reported));
    }

    @Test
    void ignoresADeclaredBitrateOfZero() {
        assertTrue(MasterPlaylist.estimateBandwidth(640, 360, 0) >= 200_000);
    }
}
