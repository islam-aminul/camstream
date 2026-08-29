package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.discovery.CameraSource;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * What the registry does with a camera the latest scan has not reached.
 *
 * "Not seen yet" and "gone" arrive looking identical, and treating them alike
 * took a working camera off the air on every restart: the configuration is
 * applied before the first sweep finishes, the camera resolves to nothing, and
 * the agent refuses the stream as unknown until a scan completes - long after
 * the viewer's demand has expired.
 */
class RegistryRetentionTest {

    /** A discovery service whose results the test moves around underneath it. */
    private static final class Scan implements CameraSource {
        private List<DiscoveredCamera> results = new ArrayList<>();

        @Override
        public List<DiscoveredCamera> redactedResults() {
            return results;
        }

        @Override
        public String streamUrl(String cameraId, String profileToken) {
            return results.stream().anyMatch(c -> c.id.equals(cameraId))
                    ? "rtsp://user:pass@10.0.0.9/stream" : null;
        }

        @Override
        public CameraSource.StreamFacts probeStream(String rtspUrl, String transport) {
            // Not exercised here: this test is about what the registry keeps,
            // not about what a stream turns out to carry.
            return null;
        }
    }

    private static DiscoveredCamera seen(String id) {
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.id = id;
        camera.ipAddress = "10.0.0.9";
        camera.identityStable = true;
        DiscoveredCamera.DiscoveredProfile profile = new DiscoveredCamera.DiscoveredProfile();
        profile.token = "sub";
        profile.name = "sub";
        profile.codec = "h264";
        profile.width = 640;
        profile.height = 360;
        profile.rtspUrl = "rtsp://user:pass@10.0.0.9/stream";
        camera.profiles.put(profile.token, profile);
        return camera;
    }

    private static CameraRegistry.Approved approval(String id) {
        return new CameraRegistry.Approved(id, id, "Gate", "sub", "sub");
    }

    @Test
    @DisplayName("keeps a camera the newest scan has not reached yet")
    void keepsWhatItAlreadyResolved() {
        Scan scan = new Scan();
        scan.results = List.of(seen("mac-aabbccddeeff"));

        CameraRegistry registry = new CameraRegistry(new AgentConfig(), scan);
        registry.setApproved(List.of(approval("mac-aabbccddeeff")));
        assertNotNull(registry.get("mac-aabbccddeeff"), "should resolve while the scan shows it");

        // A sweep starts: results are momentarily empty. The camera has not
        // moved, been unplugged or been un-approved.
        scan.results = List.of();
        registry.refresh();

        CameraConfig kept = registry.get("mac-aabbccddeeff");
        assertNotNull(kept, "a camera mid-sweep must not become an unknown camera");
    }

    @Test
    @DisplayName("still knows nothing about a camera it has never resolved")
    void doesNotInventUnseenCameras() {
        // Retention keeps what was known. It must not manufacture a camera the
        // agent has never located, which would produce a stream request with
        // no URL behind it.
        Scan scan = new Scan();
        CameraRegistry registry = new CameraRegistry(new AgentConfig(), scan);
        registry.setApproved(List.of(approval("mac-000000000000")));

        assertNull(registry.get("mac-000000000000"));
    }

    @Test
    @DisplayName("drops a camera the control plane has withdrawn")
    void forgetsUnapprovedCameras() {
        // Retention is about the scan being incomplete, not about approvals.
        // An assignment removed in the console must still take the camera away.
        Scan scan = new Scan();
        scan.results = List.of(seen("mac-aabbccddeeff"));

        CameraRegistry registry = new CameraRegistry(new AgentConfig(), scan);
        registry.setApproved(List.of(approval("mac-aabbccddeeff")));
        assertNotNull(registry.get("mac-aabbccddeeff"));

        registry.setApproved(List.of());
        assertNull(registry.get("mac-aabbccddeeff"), "an unassigned camera must not linger");
    }
}
