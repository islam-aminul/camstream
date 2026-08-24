package online.camstream.agent.config;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * One camera, with the two RTSP profiles it exposes.
 *
 * Both are stream-copied, never re-encoded. That is a licensing position as
 * much as a performance one: the agent never links an H.264 encoder, so it
 * needs neither a GPL FFmpeg build (libx264) nor an AVC encoder patent licence.
 * Bytes produced by the camera are relayed untouched to bytes decoded by the
 * viewer's browser.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class CameraConfig {

    /** Stable, URL-safe id; becomes an S3 key segment and a playlist path. */
    public String id;

    /** Human-facing label shown in the viewer. */
    public String name;

    /** Low-resolution profile used for the multi-camera grid. */
    public String subStreamUrl;

    /** Full-resolution profile, published only while a viewer has this camera open. */
    public String mainStreamUrl;

    /**
     * RTSP lower transport: "tcp" or "udp".
     *
     * TCP by default — on a congested site network UDP packet loss produces
     * macroblocking that survives into every viewer's stream. Some cameras and
     * software servers only offer UDP, hence the switch.
     */
    public String rtspTransport = "tcp";

    public String urlFor(StreamProfile profile) {
        return profile == StreamProfile.MAIN ? mainStreamUrl : subStreamUrl;
    }

    public boolean supports(StreamProfile profile) {
        String url = urlFor(profile);
        return url != null && !url.isBlank();
    }

    public void validate() {
        if (id == null || !id.matches("[a-z0-9]+(-[a-z0-9]+)*") || id.length() < 3 || id.length() > 32) {
            throw new IllegalArgumentException(
                    "camera id must be 3-32 chars of [a-z0-9-], not starting or ending with '-': " + id);
        }
        if (id.contains("--")) {
            throw new IllegalArgumentException("camera id must not contain '--': " + id);
        }
        if (!supports(StreamProfile.SUB)) {
            throw new IllegalArgumentException("camera " + id + " needs a subStreamUrl for grid view");
        }
        for (StreamProfile profile : StreamProfile.values()) {
            String url = urlFor(profile);
            if (url != null && !url.isBlank() && !url.startsWith("rtsp://")) {
                throw new IllegalArgumentException("camera " + id + " " + profile.key() + " url must be rtsp://");
            }
        }
        if (rtspTransport == null || !rtspTransport.matches("tcp|udp")) {
            throw new IllegalArgumentException(
                    "camera " + id + " rtspTransport must be \"tcp\" or \"udp\", got: " + rtspTransport);
        }
        if (name == null || name.isBlank()) {
            name = id;
        }
    }
}
