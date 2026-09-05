package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.discovery.CameraSource;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * A camera that renumbered its profiles says so once, not every sweep.
 *
 * Falling back to the largest and smallest renditions is deliberate — a camera
 * that renumbers on reboot must not take its own stream offline until somebody
 * re-approves it. But the fallback is evaluated on every sweep, so the message
 * announcing it was written every half hour for the life of the camera, twice
 * over, because the sweep runs from both the supervisor and the MQTT worker.
 *
 * Measured on a real agent log rather than assumed: twenty-four occurrences in
 * five hours, at 00:20, 00:51, 01:22, 01:52 and so on — the 1800-second
 * discovery interval, two lines each time, about the same two tokens, with
 * nothing between them changing.
 *
 * A condition that stays true until a human acts is worth saying once.
 * Repeating it buries the lines that are not permanent, which are the ones
 * somebody reading an agent log is looking for.
 *
 * These drive refresh() rather than setApproved() deliberately. setApproved
 * short-circuits on unchanged input, so an earlier version of this test that
 * called it five times reproduced nothing and passed with the fix deleted —
 * the repeat in production comes from the discovery sweep re-resolving against
 * a fresh scan.
 */
class MissingProfileNoiseTest {

    private static final class StubDiscovery implements CameraSource {
        private List<DiscoveredCamera> results;
        private final Map<String, String> urls;

        StubDiscovery(List<DiscoveredCamera> results, Map<String, String> urls) {
            this.results = results;
            this.urls = urls;
        }

        /** Lets one registry see the camera change between sweeps. */
        void nowReturns(List<DiscoveredCamera> next) {
            this.results = next;
        }

        @Override
        public StreamFacts probeStream(String rtspUrl, String transport) {
            return null;
        }

        @Override
        public List<DiscoveredCamera> redactedResults() {
            return results;
        }

        @Override
        public String streamUrl(String cameraIdentity, String profileToken) {
            return urls.get(cameraIdentity + "/" + profileToken);
        }
    }

    private PrintStream realErr;
    private ByteArrayOutputStream captured;

    @BeforeEach
    void captureLog() {
        realErr = System.err;
        captured = new ByteArrayOutputStream();
        // slf4j-simple writes to System.err and resolves it per write, so
        // replacing it here catches what the agent would actually log.
        System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
    }

    @AfterEach
    void restoreLog() {
        System.setErr(realErr);
    }

    private static AgentConfig config() {
        AgentConfig config = new AgentConfig();
        config.tenantId = "acme";
        config.premisesId = "acme-hq";
        config.deviceId = "gate-01";
        config.bucket = "b";
        config.iotCredentialsEndpoint = "c";
        config.iotDataEndpoint = "d";
        config.certificatePath = "/tmp/k.crt";
        config.privateKeyPath = "/tmp/k.key";
        config.apiInvokeUrl = "https://example.invalid";
        return config;
    }

    private static DiscoveredCamera camera(String subToken, String mainToken) {
        DiscoveredCamera found = new DiscoveredCamera();
        found.id = "sn-123456";
        found.ipAddress = "192.168.0.113";

        DiscoveredCamera.DiscoveredProfile main = new DiscoveredCamera.DiscoveredProfile();
        main.token = mainToken;
        main.name = "PROFILE_1";
        main.codec = "h264";
        main.width = 1920;
        main.height = 1080;

        DiscoveredCamera.DiscoveredProfile sub = new DiscoveredCamera.DiscoveredProfile();
        sub.token = subToken;
        sub.name = "PROFILE_2";
        sub.codec = "h264";
        sub.width = 640;
        sub.height = 360;

        found.profiles.put(main.token, main);
        found.profiles.put(sub.token, sub);
        return found.redacted();
    }

    private static long linesAbout(String log, String token) {
        return log.lines().filter(line -> line.contains("no longer has profile") && line.contains(token)).count();
    }

    @Test
    @DisplayName("the fallback is announced once, however many sweeps run")
    void saysItOnce() {
        StubDiscovery discovery = new StubDiscovery(
                List.of(camera("PROFILE_NEW_SUB", "PROFILE_NEW_MAIN")),
                Map.of(
                        "sn-123456/PROFILE_NEW_SUB", "rtsp://cam/sub",
                        "sn-123456/PROFILE_NEW_MAIN", "rtsp://cam/main"));

        CameraRegistry registry = new CameraRegistry(config(), discovery);
        CameraRegistry.Approved approval = new CameraRegistry.Approved(
                "sn-123456", "reception", "Reception", "PROFILE_OLD_SUB", "PROFILE_OLD_MAIN");

        registry.setApproved(List.of(approval));
        // Five discovery sweeps, which on a real agent is two and a half
        // hours. This is the path that repeated in production: setApproved
        // short-circuits on unchanged input, so driving it instead reproduces
        // nothing and would let this pass with the fix deleted.
        for (int i = 0; i < 5; i++) {
            registry.refresh();
        }

        String log = captured.toString(StandardCharsets.UTF_8);
        assertEquals(1, linesAbout(log, "PROFILE_OLD_MAIN"),
                "the main profile should be reported once, log was:\n" + log);
        assertEquals(1, linesAbout(log, "PROFILE_OLD_SUB"),
                "the sub profile should be reported once, log was:\n" + log);
    }

    @Test
    @DisplayName("a profile that comes back and goes again is reported again")
    void saysItAgainAfterRecovery() {
        // Not merely tidiness. Suppressing for the life of the process would
        // hide a camera flapping between two sets of tokens - a real fault
        // that would otherwise look identical in the log to one that
        // renumbered once and settled.
        CameraRegistry.Approved approval = new CameraRegistry.Approved(
                "sn-123456", "reception", "Reception", "PROFILE_OLD_SUB", "PROFILE_OLD_MAIN");
        Map<String, String> urls = Map.of(
                "sn-123456/PROFILE_NEW_SUB", "rtsp://cam/sub",
                "sn-123456/PROFILE_NEW_MAIN", "rtsp://cam/main",
                "sn-123456/PROFILE_OLD_SUB", "rtsp://cam/sub",
                "sn-123456/PROFILE_OLD_MAIN", "rtsp://cam/main");

        List<DiscoveredCamera> renumbered = List.of(camera("PROFILE_NEW_SUB", "PROFILE_NEW_MAIN"));
        List<DiscoveredCamera> restored = List.of(camera("PROFILE_OLD_SUB", "PROFILE_OLD_MAIN"));

        StubDiscovery discovery = new StubDiscovery(renumbered, urls);
        CameraRegistry registry = new CameraRegistry(config(), discovery);

        registry.setApproved(List.of(approval));   // gone: reported
        registry.refresh();                        // still gone: silent
        discovery.nowReturns(restored);
        registry.refresh();                        // back: nothing to say
        discovery.nowReturns(renumbered);
        registry.refresh();                        // gone again: reported

        String log = captured.toString(StandardCharsets.UTF_8);
        assertEquals(2, linesAbout(log, "PROFILE_OLD_MAIN"),
                "a second disappearance is a second event, log was:\n" + log);
    }
}
