package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.discovery.DiscoveredCamera;
import online.camstream.agent.discovery.CameraSource;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class CameraRegistryTest {

    /** Stands in for a real scan; returns whatever the test planted. */
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
        config.deviceId = "site-01";
        config.bucket = "b";
        config.iotCredentialsEndpoint = "c";
        config.iotDataEndpoint = "d";
        config.keystorePath = "/tmp/k.p12";
        config.certificatePath = "/tmp/k.crt";
        config.privateKeyPath = "/tmp/k.key";
        config.apiInvokeUrl = "https://example.invalid";
        return config;
    }

    private static DiscoveredCamera discovered(String identity, String codec, int width, int height) {
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.id = identity;
        camera.ipAddress = "192.168.1.50";
        DiscoveredCamera.DiscoveredProfile main = new DiscoveredCamera.DiscoveredProfile();
        main.token = "MainProfile";
        main.codec = codec;
        main.width = width;
        main.height = height;
        DiscoveredCamera.DiscoveredProfile sub = new DiscoveredCamera.DiscoveredProfile();
        sub.token = "SubProfile";
        sub.codec = codec;
        sub.width = 640;
        sub.height = 360;
        camera.profiles.put(main.token, main);
        camera.profiles.put(sub.token, sub);
        return camera;
    }

    @Test
    void resolvesAnApprovedCameraFromTheAgentsOwnScan() {
        DiscoveredCamera found = discovered("sn-ABC", "hevc", 1920, 1080);
        StubDiscovery discovery = new StubDiscovery(List.of(found), Map.of(
                "sn-ABC/SubProfile", "rtsp://user:pass@192.168.1.50/sub",
                "sn-ABC/MainProfile", "rtsp://user:pass@192.168.1.50/main"));

        CameraRegistry registry = new CameraRegistry(config(), discovery);
        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-ABC", "front-door", "Front Door", "SubProfile", "MainProfile")));

        CameraConfig camera = registry.get("front-door");
        assertNotNull(camera, "approved camera should become publishable");
        assertEquals("Front Door", camera.name);
        // The credential-bearing URL is assembled on the agent, never sent down.
        assertEquals("rtsp://user:pass@192.168.1.50/main", camera.mainStreamUrl);
        assertEquals("hevc", camera.sourceCodec, "codec drives the transcode decision");
        assertEquals(1080, camera.mainHeight);
        assertEquals(360, camera.subHeight);
    }

    @Test
    void ignoresAnApprovalForACameraThisAgentHasNotSeen() {
        StubDiscovery discovery = new StubDiscovery(List.of(), Map.of());
        CameraRegistry registry = new CameraRegistry(config(), discovery);

        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-UNSEEN", "ghost", "Ghost", "SubProfile", "MainProfile")));

        assertNull(registry.get("ghost"),
                "an assignment for an unseen camera must not produce a broken pipeline");
    }

    @Test
    void ignoresAnApprovalWithNoUsableStreamUrl() {
        // Discovered, but never authenticated — so no stream URL exists.
        StubDiscovery discovery = new StubDiscovery(List.of(discovered("sn-LOCKED", "h264", 1920, 1080)), Map.of());
        CameraRegistry registry = new CameraRegistry(config(), discovery);

        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-LOCKED", "locked", "Locked", "SubProfile", "MainProfile")));

        assertNull(registry.get("locked"), "missing credentials must not yield a camera");
    }

    @Test
    void locallyConfiguredCamerasWinOverRemoteAssignments() {
        AgentConfig config = config();
        CameraConfig local = new CameraConfig();
        local.id = "front-door";
        local.name = "Configured Locally";
        local.subStreamUrl = "rtsp://192.168.1.99/local";
        local.validate();
        config.cameras.add(local);

        StubDiscovery discovery = new StubDiscovery(List.of(discovered("sn-ABC", "h264", 1920, 1080)), Map.of(
                "sn-ABC/SubProfile", "rtsp://192.168.1.50/sub"));
        CameraRegistry registry = new CameraRegistry(config, discovery);
        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-ABC", "front-door", "Remote Name", "SubProfile", "MainProfile")));

        assertEquals("Configured Locally", registry.get("front-door").name,
                "an operator editing agent.yaml should not be silently overridden");
    }

    @Test
    void aSingleProfileStillFillsBothRoles() {
        DiscoveredCamera found = discovered("sn-ONE", "h264", 1280, 720);
        found.profiles.remove("SubProfile");
        StubDiscovery discovery = new StubDiscovery(List.of(found), Map.of(
                "sn-ONE/MainProfile", "rtsp://192.168.1.50/only"));

        CameraRegistry registry = new CameraRegistry(config(), discovery);
        registry.setApproved(List.of(new CameraRegistry.Approved(
                "sn-ONE", "single", "Single", "SubProfile", "MainProfile")));

        CameraConfig camera = registry.get("single");
        assertNotNull(camera);
        assertEquals(camera.mainStreamUrl, camera.subStreamUrl,
                "one stream should serve both the grid and the detail view");
    }
}
