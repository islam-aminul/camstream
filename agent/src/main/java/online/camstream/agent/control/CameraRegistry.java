package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.discovery.DiscoveredCamera;
import online.camstream.agent.discovery.CameraSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The cameras this agent may publish, from both sources that produce them.
 *
 * Cameras written into {@code agent.yaml} are static and always present.
 * Cameras an administrator approved arrive in the heartbeat response as an
 * identity plus a pair of profile tokens — never as a URL, because the URL
 * embeds credentials and the control plane has never seen either. The agent
 * resolves them against its own most recent scan, so the credential-bearing
 * part of the configuration is assembled entirely on-premises.
 */
public final class CameraRegistry {

    private static final Logger log = LoggerFactory.getLogger(CameraRegistry.class);

    /** An assignment handed down by the control plane. */
    public record Approved(
            String identity,
            String cameraId,
            String displayName,
            String subProfileToken,
            String mainProfileToken) {}

    private final AgentConfig config;
    private final CameraSource discovery;

    /** cameraId -> camera, for whatever is currently publishable. */
    private final Map<String, CameraConfig> cameras = new ConcurrentHashMap<>();
    private volatile List<Approved> approved = List.of();

    public CameraRegistry(AgentConfig config, CameraSource discovery) {
        this.config = config;
        this.discovery = discovery;
        rebuild();
    }

    /** Replaces the approved set; ignored if it has not changed. */
    public void setApproved(List<Approved> assignments) {
        if (assignments.equals(approved)) {
            return;
        }
        approved = List.copyOf(assignments);
        log.info("control plane assigned {} camera(s) to this agent", approved.size());
        rebuild();
    }

    /** Re-resolves approved cameras against the latest scan. Cheap; safe to call often. */
    public void refresh() {
        if (!approved.isEmpty()) {
            rebuild();
        }
    }

    public CameraConfig get(String cameraId) {
        return cameras.get(cameraId);
    }

    public Collection<CameraConfig> all() {
        return cameras.values();
    }

    private void rebuild() {
        Map<String, CameraConfig> resolved = new LinkedHashMap<>();

        // Locally configured cameras win: an operator editing agent.yaml has
        // made a deliberate choice that a remote assignment should not silently
        // override.
        for (CameraConfig camera : config.cameras) {
            resolved.put(camera.id, camera);
        }

        List<DiscoveredCamera> scan = discovery.redactedResults();
        for (Approved assignment : approved) {
            if (resolved.containsKey(assignment.cameraId())) {
                continue;
            }
            CameraConfig camera = resolve(assignment, scan);
            if (camera != null) {
                resolved.put(camera.id, camera);
            }
        }

        cameras.keySet().retainAll(resolved.keySet());
        cameras.putAll(resolved);
    }

    /**
     * Turns an assignment into something streamable, or null if this agent has
     * not yet seen the camera — which happens legitimately between an
     * administrator approving one and the next discovery sweep.
     */
    private CameraConfig resolve(Approved assignment, List<DiscoveredCamera> scan) {
        DiscoveredCamera found = scan.stream()
                .filter(camera -> assignment.identity().equals(camera.id))
                .findFirst()
                .orElse(null);
        if (found == null) {
            log.debug("approved camera {} has not been seen by this agent yet", assignment.identity());
            return null;
        }

        String subUrl = discovery.streamUrl(assignment.identity(), assignment.subProfileToken());
        String mainUrl = discovery.streamUrl(assignment.identity(), assignment.mainProfileToken());
        if (subUrl == null && mainUrl == null) {
            log.warn("approved camera {} has no usable stream URL — credentials may be missing",
                    assignment.identity());
            return null;
        }

        CameraConfig camera = new CameraConfig();
        camera.id = assignment.cameraId();
        camera.name = assignment.displayName();
        // A camera with only one usable profile still works: both roles point
        // at the same stream rather than leaving the grid blank.
        camera.subStreamUrl = subUrl != null ? subUrl : mainUrl;
        camera.mainStreamUrl = mainUrl != null ? mainUrl : subUrl;
        camera.rtspTransport = config.cameras.isEmpty() ? "tcp" : config.cameras.get(0).rtspTransport;

        DiscoveredCamera.DiscoveredProfile sub = found.profiles.get(assignment.subProfileToken());
        DiscoveredCamera.DiscoveredProfile main = found.profiles.get(assignment.mainProfileToken());
        if (sub != null) {
            camera.subWidth = sub.width;
            camera.subHeight = sub.height;
            camera.subBitrateKbps = sub.bitrateKbps;
        }
        if (main != null) {
            camera.mainWidth = main.width;
            camera.mainHeight = main.height;
            camera.mainBitrateKbps = main.bitrateKbps;
            camera.sourceCodec = main.codec;
        } else if (sub != null) {
            camera.sourceCodec = sub.codec;
        }

        camera.validate();
        return camera;
    }

    /** Everything reportable upward, for the heartbeat's camera list. */
    public List<CameraConfig> reportable() {
        return new ArrayList<>(cameras.values());
    }

    /** Whether a camera can serve the requested profile at all. */
    public boolean supports(String cameraId, StreamProfile profile) {
        CameraConfig camera = cameras.get(cameraId);
        return camera != null && camera.supports(profile);
    }
}
