package online.camstream.agent.discovery;

import java.util.List;

/**
 * Where the agent's knowledge of local cameras comes from.
 *
 * Exists so that consumers depend on the question rather than on
 * {@link DiscoveryService}, which owns network scanning, ONVIF and process
 * execution. That separation is what lets camera resolution be reasoned about —
 * and tested — without a LAN.
 */
public interface CameraSource {

    /** Cameras seen in the most recent sweep, with credentials removed. */
    List<DiscoveredCamera> redactedResults();

    /**
     * The usable RTSP URL for a camera profile, or null.
     *
     * May embed credentials, so this is agent-internal and never reported.
     */
    String streamUrl(String cameraIdentity, String profileToken);
}
