package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.discovery.CameraSource;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Regressions from a real CP Plus camera.
 *
 * Each of these cost a physical power cycle or a live network to find, and none
 * were reachable with a mock — so they are pinned here rather than left to be
 * rediscovered.
 */
class ProfileResolutionTest {

    private record StubDiscovery(List<DiscoveredCamera> results, Map<String, String> urls) implements CameraSource {
        @Override
        public List<DiscoveredCamera> redactedResults() {
            return results;
        }

        @Override
        public String streamUrl(String cameraIdentity, String profileToken) {
            return urls.get(cameraIdentity + "/" + profileToken);
        }
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

    /** Built the way the agent sees it: redacted, so rtspUrl is always null. */
    private static DiscoveredCamera cameraWithTokens(String subToken, String mainToken) {
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.id = "sn-123456";
        camera.ipAddress = "192.168.0.113";

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

        camera.profiles.put(main.token, main);
        camera.profiles.put(sub.token, sub);
        // Exactly what the registry receives: redaction clears the URLs.
        return camera.redacted();
    }

    @Test
    void redactionAlwaysClearsTheStreamUrl() {
        // The trap that defeated the first attempt at the fix below: any logic
        // in CameraRegistry that inspects rtspUrl is inspecting null.
        DiscoveredCamera redacted = cameraWithTokens("SUB", "MAIN");
        assertTrue(redacted.profiles.values().stream().allMatch(p -> p.rtspUrl == null),
                "redacted profiles must never carry a credential-bearing URL");
    }

    @Test
    void usesTheApprovedTokensWhenTheyStillExist() {
        StubDiscovery discovery = new StubDiscovery(
                List.of(cameraWithTokens("PROFILE_2", "PROFILE_1")),
                Map.of("sn-123456/PROFILE_2", "rtsp://cam/sub", "sn-123456/PROFILE_1", "rtsp://cam/main"));

        CameraRegistry registry = new CameraRegistry(config(), discovery);
        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-123456", "reception", "Reception", "PROFILE_2", "PROFILE_1")));

        CameraConfig camera = registry.get("reception");
        assertNotNull(camera);
        assertEquals("rtsp://cam/sub", camera.subStreamUrl);
        assertEquals("rtsp://cam/main", camera.mainStreamUrl);
    }

    @Test
    void survivesACameraRenumberingItsProfilesOnReboot() {
        // The real failure: a power cycle turned PROFILE_971996686 into
        // PROFILE_1095718317, and the approval pointed at a token that no
        // longer existed. Falling back by size keeps the camera streaming.
        StubDiscovery discovery = new StubDiscovery(
                List.of(cameraWithTokens("PROFILE_1095718318", "PROFILE_1095718317")),
                Map.of(
                        "sn-123456/PROFILE_1095718318", "rtsp://cam/sub",
                        "sn-123456/PROFILE_1095718317", "rtsp://cam/main"));

        CameraRegistry registry = new CameraRegistry(config(), discovery);
        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-123456", "reception", "Reception", "PROFILE_971996687", "PROFILE_971996686")));

        CameraConfig camera = registry.get("reception");
        assertNotNull(camera, "a renumbered camera must not go silently offline");
        assertEquals("rtsp://cam/sub", camera.subStreamUrl, "smallest rendition drives the grid");
        assertEquals("rtsp://cam/main", camera.mainStreamUrl, "largest rendition drives the detail view");
        assertEquals(360, camera.subHeight);
        assertEquals(1080, camera.mainHeight);
    }

    @Test
    void aSingleRenditionFillsBothRolesAfterRenumbering() {
        DiscoveredCamera camera = cameraWithTokens("GONE", "ONLY");
        camera.profiles.remove("GONE");
        StubDiscovery discovery = new StubDiscovery(
                List.of(camera), Map.of("sn-123456/ONLY", "rtsp://cam/only"));

        CameraRegistry registry = new CameraRegistry(config(), discovery);
        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-123456", "reception", "Reception", "STALE_SUB", "STALE_MAIN")));

        CameraConfig resolved = registry.get("reception");
        assertNotNull(resolved);
        assertEquals(resolved.mainStreamUrl, resolved.subStreamUrl);
    }
}
