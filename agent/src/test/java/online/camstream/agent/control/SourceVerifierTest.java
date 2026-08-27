package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.discovery.CameraSource;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * A camera written into agent.yaml is described by whoever typed it, working
 * from the camera's own web UI — which calls High 10 "H.264" like everything
 * else. The stream is the only authority worth having.
 */
class SourceVerifierTest {

    private final AtomicInteger probes = new AtomicInteger();

    private static CameraConfig camera(String id, String codec, String profile) {
        CameraConfig camera = new CameraConfig();
        camera.id = id;
        camera.name = id;
        camera.subStreamUrl = "rtsp://cam/" + id + "/sub";
        camera.mainStreamUrl = "rtsp://cam/" + id + "/main";
        camera.sourceCodec = codec;
        camera.sourceCodecProfile = profile;
        camera.locallyConfigured = true;
        return camera;
    }

    private CameraRegistry registryOf(CameraConfig... cameras) {
        AgentConfig config = new AgentConfig();
        config.cameras = List.of(cameras);
        return new CameraRegistry(config, new CameraSource() {
            @Override public List<DiscoveredCamera> redactedResults() { return List.of(); }
            @Override public String streamUrl(String id, String token) { return null; }
            @Override public StreamFacts probeStream(String url, String transport) { return null; }
        });
    }

    private SourceVerifier verifier(CameraRegistry registry, Map<String, CameraSource.StreamFacts> truth) {
        return new SourceVerifier(new CameraSource() {
            @Override public List<DiscoveredCamera> redactedResults() { return List.of(); }
            @Override public String streamUrl(String id, String token) { return null; }
            @Override public StreamFacts probeStream(String url, String transport) {
                probes.incrementAndGet();
                return truth.get(url);
            }
        }, registry);
    }

    @Test
    void correctsAConfigurationThatUnderstatesTheProfile() {
        CameraConfig camera = camera("gate", "h264", null);
        CameraRegistry registry = registryOf(camera);
        SourceVerifier verifier = verifier(registry, Map.of(
                "rtsp://cam/gate/main", new CameraSource.StreamFacts("h264", "High 10", 31, 1920, 1080),
                "rtsp://cam/gate/sub", new CameraSource.StreamFacts("h264", "High 10", 31, 640, 360)));

        assertTrue(verifier.verify(), "the correction is worth reporting upward");
        assertEquals("High 10", camera.sourceCodecProfile);
        assertEquals(31, camera.sourceCodecLevel);
        assertFalse(camera.browserPlayable(),
                "which is the point: this now offers a transcode instead of an unplayable stream");
    }

    @Test
    void correctsACodecThatIsSimplyWrong() {
        CameraConfig camera = camera("dome", "h264", "Main");
        CameraRegistry registry = registryOf(camera);
        SourceVerifier verifier = verifier(registry, Map.of(
                "rtsp://cam/dome/main", new CameraSource.StreamFacts("hevc", "Main", 93, 1920, 1080)));

        assertTrue(verifier.verify());
        assertEquals("hevc", camera.sourceCodec);
    }

    @Test
    void reportsNothingWhenTheConfigurationWasRight() {
        CameraConfig camera = camera("lobby", "h264", "Main");
        CameraRegistry registry = registryOf(camera);
        SourceVerifier verifier = verifier(registry, Map.of(
                "rtsp://cam/lobby/main", new CameraSource.StreamFacts("h264", "Main", 31, 1920, 1080),
                "rtsp://cam/lobby/sub", new CameraSource.StreamFacts("h264", "Main", 31, 640, 360)));

        assertFalse(verifier.verify(), "an unchanged view must not cost a report");
    }

    @Test
    void probesEachUrlOnlyOnce() {
        CameraConfig camera = camera("yard", "h264", "Main");
        CameraRegistry registry = registryOf(camera);
        SourceVerifier verifier = verifier(registry, Map.of(
                "rtsp://cam/yard/main", new CameraSource.StreamFacts("h264", "Main", 31, 1920, 1080),
                "rtsp://cam/yard/sub", new CameraSource.StreamFacts("h264", "Main", 31, 640, 360)));

        verifier.verify();
        int afterFirst = probes.get();
        verifier.verify();
        assertEquals(afterFirst, probes.get(),
                "each probe is an ffprobe against the camera; a settled site should do no work");
    }

    @Test
    void survivesACameraThatIsSimplyOffline() {
        CameraConfig camera = camera("gate", "h264", "Main");
        CameraRegistry registry = registryOf(camera);
        SourceVerifier verifier = verifier(registry, Map.of());

        assertFalse(verifier.verify());
        assertEquals("Main", camera.sourceCodecProfile, "an unreachable camera tells us nothing new");
    }

    @Test
    void carriesTheUnplayableRenditionWhenTheTwoDisagree() {
        // A viewer meets whichever one is broken: the grid uses sub and the
        // detail view uses main. Offering a transcode that turns out to be
        // unnecessary is much cheaper than a stream that never appears.
        CameraSource.StreamFacts playable = new CameraSource.StreamFacts("h264", "High", 40, 1920, 1080);
        CameraSource.StreamFacts not = new CameraSource.StreamFacts("h264", "High 10", 31, 640, 360);

        assertEquals(not, SourceVerifier.choose(playable, not));
        assertEquals(not, SourceVerifier.choose(not, playable));
        assertEquals(playable, SourceVerifier.choose(playable, playable));
    }
}
