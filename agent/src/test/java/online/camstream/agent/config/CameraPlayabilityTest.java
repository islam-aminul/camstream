package online.camstream.agent.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Which streams a browser can decode, which is not the same question as which
 * codec a camera reports.
 */
class CameraPlayabilityTest {

    private static CameraConfig camera(String codec, String profile) {
        CameraConfig camera = new CameraConfig();
        camera.sourceCodec = codec;
        camera.sourceCodecProfile = profile;
        return camera;
    }

    @Test
    void acceptsTheEightBitProfilesEveryBrowserDecodes() {
        assertTrue(camera("h264", "Constrained Baseline").browserPlayable());
        assertTrue(camera("h264", "Main").browserPlayable());
        assertTrue(camera("h264", "High").browserPlayable());
        assertTrue(camera("avc1", "High").browserPlayable());
    }

    @Test
    void rejectsTenBitAndHigherChromaEvenThoughTheyAreH264() {
        // The whole point: these carry codec_name "h264" and no browser will
        // decode any of them. Treating the codec name as the answer meant a
        // viewer asking for a transcode got a stream copy of the same thing.
        assertFalse(camera("h264", "High 10").browserPlayable());
        assertFalse(camera("h264", "High 4:2:2").browserPlayable());
        assertFalse(camera("h264", "High 4:4:4 Predictive").browserPlayable());
    }

    @Test
    void rejectsHevcWhateverItsProfile() {
        assertFalse(camera("hevc", "Main").browserPlayable());
        assertFalse(camera("h265", null).browserPlayable());
    }

    @Test
    void assumesAnUnknownProfileIsFine() {
        // Guessing the other way would transcode streams that never needed it,
        // on edge boxes that may have no encoder to do it with.
        assertTrue(camera("h264", null).browserPlayable());
        assertTrue(camera("h264", "").browserPlayable());
        assertTrue(camera("h264", "Some Future Profile").browserPlayable());
    }

    @Test
    void treatsAnUnknownCodecAsUnplayable() {
        assertFalse(camera(null, null).browserPlayable());
        assertFalse(camera("mjpeg", null).browserPlayable());
    }
}
