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

    /**
     * What a stream actually carries, read from the stream itself.
     *
     * Returns null when the URL could not be opened, which is a normal state
     * for a camera that is offline rather than an error.
     */
    StreamFacts probeStream(String rtspUrl, String transport);

    /**
     * The facts about a stream that decide how it can be served.
     *
     * Profile is here alongside codec because it decides playability on its
     * own: H.264 High 10 reports codec "h264" and no browser decodes it.
     */
    record StreamFacts(String codec, String profile, Integer level, Integer width, Integer height) {}
}
