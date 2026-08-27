package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.discovery.CameraSource;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * An encode costs roughly a core per 1080p stream. Without a cap, a few
 * viewers opening HEVC cameras can take an edge box down — and take the cheap
 * stream copies with it, so the failure lands on cameras that were working.
 */
class TranscodeCapTest {

    private static CameraConfig camera(String id, String codec, String profile) {
        CameraConfig camera = new CameraConfig();
        camera.id = id;
        camera.name = id;
        camera.subStreamUrl = "rtsp://cam/" + id + "/sub";
        camera.sourceCodec = codec;
        camera.sourceCodecProfile = profile;
        return camera;
    }

    /** The minimum a config needs before validate() will look at anything else. */
    private static AgentConfig valid() {
        AgentConfig config = new AgentConfig();
        config.tenantId = "demo";
        config.premisesId = "site";
        config.deviceId = "box";
        config.bucket = "bucket";
        config.iotCredentialsEndpoint = "https://credentials.example";
        config.certificatePath = "/tmp/cert.pem";
        config.privateKeyPath = "/tmp/key.pem";
        config.apiInvokeUrl = "https://api.example";
        config.iotDataEndpoint = "data.example";
        config.cameras = List.of(camera("cam-a", "h264", "Main"));
        return config;
    }

    private static CameraRegistry registry(CameraConfig... cameras) {
        AgentConfig config = new AgentConfig();
        config.cameras = List.of(cameras);
        return new CameraRegistry(config, new CameraSource() {
            @Override public List<DiscoveredCamera> redactedResults() { return List.of(); }
            @Override public String streamUrl(String id, String token) { return null; }
            @Override public StreamFacts probeStream(String url, String transport) { return null; }
        });
    }

    @Test
    void aStreamCopyIsNotATranscodeHoweverItIsLabelled() {
        // An 8-bit H.264 camera asked for the "h264" variant is copied, not
        // encoded, so it must not consume a slot.
        CameraRegistry registry = registry(camera("plain", "h264", "Main"));
        assertTrue(registry.get("plain").browserPlayable());
    }

    @Test
    void anExoticH264ProfileStillCountsAsATranscode() {
        CameraRegistry registry = registry(camera("tenbit", "h264", "High 10"));
        assertFalse(registry.get("tenbit").browserPlayable(),
                "this is H.264 that must actually be re-encoded, not copied");
    }

    @Test
    void theCapIsAWholeNumberWithinReason() {
        AgentConfig config = valid();

        config.maxConcurrentTranscodes = -1;
        assertThrows(IllegalArgumentException.class, config::validate);

        config.maxConcurrentTranscodes = 65;
        assertThrows(IllegalArgumentException.class, config::validate);

        // Zero is legitimate: a site that serves camera bytes only.
        config.maxConcurrentTranscodes = 0;
        assertDoesNotThrow(config::validate);
    }

    @Test
    void defaultsToOne() {
        assertEquals(1, new AgentConfig().maxConcurrentTranscodes,
                "the safe assumption for hardware nobody has measured");
    }

    @Test
    void profileKeysAreStable() {
        assertEquals("sub", StreamProfile.SUB.key());
        assertEquals("main", StreamProfile.MAIN.key());
    }

    private static Rendition transcode(String cameraId) {
        return new Rendition(cameraId, StreamProfile.SUB, Variant.H264);
    }

    @Test
    void grantsOnlyAsManySlotsAsRemain() {
        List<Rendition> wanted = List.of(transcode("cam-a"), transcode("cam-b"), transcode("cam-c"));

        StreamManager.Split none = StreamManager.withinCap(wanted, 0, 1);
        assertEquals(List.of(transcode("cam-a")), none.start());
        assertEquals(2, none.refuse().size());

        StreamManager.Split some = StreamManager.withinCap(wanted, 1, 3);
        assertEquals(2, some.start().size(), "two slots left of three");
        assertEquals(1, some.refuse().size());
    }

    @Test
    void refusesEverythingWhenTheSlotsAreAlreadyFull() {
        List<Rendition> wanted = List.of(transcode("cam-a"));
        StreamManager.Split split = StreamManager.withinCap(wanted, 2, 2);
        assertTrue(split.start().isEmpty());
        assertEquals(wanted, split.refuse());
    }

    @Test
    void neverTakesASlotBackFromAStreamAlreadyRunning() {
        // Being one over the limit until a stream stops on its own is better
        // than cutting off somebody who is watching it.
        StreamManager.Split split = StreamManager.withinCap(List.of(), 5, 1);
        assertTrue(split.start().isEmpty());
        assertTrue(split.refuse().isEmpty());
    }

    @Test
    void refusesEverythingWhenTheSiteIsSetNotToTranscode() {
        StreamManager.Split split = StreamManager.withinCap(List.of(transcode("cam-a")), 0, 0);
        assertTrue(split.start().isEmpty());
        assertEquals(1, split.refuse().size());
    }

    @Test
    void picksTheSameOneEachTimeRatherThanFlapping() {
        List<Rendition> oneOrder = List.of(transcode("cam-c"), transcode("cam-a"), transcode("cam-b"));
        List<Rendition> another = List.of(transcode("cam-b"), transcode("cam-c"), transcode("cam-a"));

        assertEquals(StreamManager.withinCap(oneOrder, 0, 1).start(),
                StreamManager.withinCap(another, 0, 1).start(),
                "a set arriving in a different order must not move the stream");
    }
}
