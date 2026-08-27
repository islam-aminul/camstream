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
     * Hardware encoder used when a viewer's browser cannot decode this
     * camera's native codec. Only consulted for transcoded renditions; the
     * default publishes the camera's own bytes untouched.
     *
     * One of: copy, vaapi, nvenc, v4l2m2m, qsv, amf, videotoolbox, custom.
     */
    public String encoder = "copy";

    /** Render node for vaapi, e.g. /dev/dri/renderD128. */
    public String encoderDevice;

    /** Target bitrate for transcoded output. Defaults to 2000. */
    public Integer encoderBitrateKbps;

    /** Optional downscale, e.g. 720. Null keeps the source resolution. */
    public Integer encoderMaxHeight;

    /** Verbatim ffmpeg output arguments; required when encoder is "custom". */
    public java.util.List<String> encoderArgs;

    /**
     * Rendition dimensions, filled in by discovery. Used only to describe the
     * ABR ladder; playback works without them, it just cannot advertise
     * resolutions.
     */
    public Integer subWidth;
    public Integer subHeight;
    public Integer subBitrateKbps;
    public Integer mainWidth;
    public Integer mainHeight;
    public Integer mainBitrateKbps;

    /**
     * Video codec the camera actually produces, filled in by discovery or
     * probing. Reported upward so the control plane can decide whether a given
     * browser needs a transcode at all.
     */
    public String sourceCodec;

    /**
     * The codec profile the camera produces, e.g. "Main" or "High 10".
     *
     * Carried separately from the codec name because it decides playability on
     * its own: High 10 is H.264 that no browser will decode.
     */
    public String sourceCodecProfile;

    /** Codec level times ten, as ffprobe reports it. */
    public Integer sourceCodecLevel;

    /**
     * Whether a browser can be expected to decode this camera's own stream.
     *
     * H.264 up to High profile is decoded everywhere. The 10-bit and
     * higher-chroma profiles are not decoded anywhere, despite carrying the
     * same codec name, and HEVC only on Safari and some Windows builds. An
     * unknown profile is assumed playable: guessing otherwise would transcode
     * streams that never needed it, on hardware that may not have an encoder.
     */
    public boolean browserPlayable() {
        if (sourceCodec == null || !sourceCodec.toLowerCase(java.util.Locale.ROOT).matches("h264|avc1?")) {
            return false;
        }
        if (sourceCodecProfile == null || sourceCodecProfile.isBlank()) {
            return true;
        }
        return switch (sourceCodecProfile.toLowerCase(java.util.Locale.ROOT)) {
            case "high 10", "high 10 intra", "high 4:2:2", "high 4:2:2 intra",
                 "high 4:4:4 predictive", "high 4:4:4 intra", "cavlc 4:4:4" -> false;
            default -> true;
        };
    }

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

    public Integer widthFor(StreamProfile profile) {
        return profile == StreamProfile.MAIN ? mainWidth : subWidth;
    }

    public Integer heightFor(StreamProfile profile) {
        return profile == StreamProfile.MAIN ? mainHeight : subHeight;
    }

    public Integer bitrateFor(StreamProfile profile) {
        return profile == StreamProfile.MAIN ? mainBitrateKbps : subBitrateKbps;
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
        // Throws with the valid set if the name is unknown.
        online.camstream.agent.media.EncoderProfile.fromKey(encoder);
        if (rtspTransport == null || !rtspTransport.matches("tcp|udp")) {
            throw new IllegalArgumentException(
                    "camera " + id + " rtspTransport must be \"tcp\" or \"udp\", got: " + rtspTransport);
        }
        if (name == null || name.isBlank()) {
            name = id;
        }
    }
}
