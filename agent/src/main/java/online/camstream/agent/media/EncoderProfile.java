package online.camstream.agent.media;

import java.util.List;
import java.util.Locale;

/**
 * How a rendition's video is produced.
 *
 * {@link #COPY} is the default and the only one that involves no encoder at
 * all. Every other profile names a *hardware* encoder: those are LGPL, so an
 * operator can transcode without needing a GPL FFmpeg build. libx264 is
 * deliberately absent — it would force {@code --enable-gpl} on the whole binary
 * and drag the product into copyleft. An operator who genuinely wants software
 * encoding can express it through {@link #CUSTOM}, and owns that decision.
 *
 * Unlike the rest of the agent, these are not portable. The jar runs on any
 * architecture because AWS CRT bundles a native for each, but an encoder exists
 * only where the silicon does:
 *
 * <table>
 *   <caption>Where each profile is available</caption>
 *   <tr><th>Profile</th><th>Architecture</th></tr>
 *   <tr><td>{@link #VAAPI}</td><td>x86_64, Intel or AMD integrated graphics</td></tr>
 *   <tr><td>{@link #QSV}</td><td>x86_64, Intel only</td></tr>
 *   <tr><td>{@link #AMF}</td><td>x86_64, AMD on Windows</td></tr>
 *   <tr><td>{@link #NVENC}</td><td>x86_64 with an NVIDIA GPU, or arm64 on Jetson</td></tr>
 *   <tr><td>{@link #V4L2M2M}</td><td>arm64/armv7 SoCs — Raspberry Pi and similar</td></tr>
 *   <tr><td>{@link #VIDEOTOOLBOX}</td><td>macOS, both architectures</td></tr>
 * </table>
 */
public enum EncoderProfile {

    /** Stream-copy. No encoder, no licensing exposure, negligible CPU. */
    COPY,

    /** Intel/AMD integrated GPU on Linux, via VA-API. */
    VAAPI,

    /** NVIDIA GPUs, Linux and Windows. */
    NVENC,

    /** Raspberry Pi and other ARM SoCs exposing a V4L2 mem2mem encoder. */
    V4L2M2M,

    /** Intel Quick Sync. Best option on Windows with Intel graphics. */
    QSV,

    /** AMD GPUs on Windows. */
    AMF,

    /** macOS, for completeness — not a supported edge platform. */
    VIDEOTOOLBOX,

    /** Escape hatch: operator supplies the output arguments verbatim. */
    CUSTOM;

    public String key() {
        return name().toLowerCase(Locale.ROOT);
    }

    public boolean isTranscode() {
        return this != COPY;
    }

    public static EncoderProfile fromKey(String key) {
        if (key == null || key.isBlank()) {
            return COPY;
        }
        String normalised = key.trim().toLowerCase(Locale.ROOT).replace("-", "").replace("_", "");
        for (EncoderProfile profile : values()) {
            if (profile.key().replace("_", "").equals(normalised)) {
                return profile;
            }
        }
        throw new IllegalArgumentException(
                "unknown encoder profile \"" + key + "\"; expected one of " + List.of(values()));
    }

    /** The ffmpeg encoder name, or null for {@link #COPY} and {@link #CUSTOM}. */
    public String encoderName() {
        return switch (this) {
            case COPY, CUSTOM -> null;
            case VAAPI -> "h264_vaapi";
            case NVENC -> "h264_nvenc";
            case V4L2M2M -> "h264_v4l2m2m";
            case QSV -> "h264_qsv";
            case AMF -> "h264_amf";
            case VIDEOTOOLBOX -> "h264_videotoolbox";
        };
    }
}
