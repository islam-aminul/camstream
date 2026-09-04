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
 * {@link #OPENH264} is the exception: a software encoder that is nonetheless
 * licence-clean. Without it a box with no GPU could not transcode at all, which
 * left a camera emitting HEVC or H.264 High 10 unplayable with no remedy
 * available — the transcode offer would appear and then quietly copy.
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
 *   <tr><td>{@link #OPENH264}</td><td>anywhere, in software — the no-GPU fallback</td></tr>
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

    /**
     * Cisco's libopenh264, in software.
     *
     * BSD-2-Clause, so unlike libx264 it needs neither {@code --enable-gpl} nor
     * {@code --enable-nonfree}, and the resulting build stays LGPL. It is the
     * fallback for edge boxes with no usable hardware encoder; expect roughly a
     * core per 1080p stream, which is why it is never chosen automatically.
     */
    OPENH264,

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
            case OPENH264 -> "libopenh264";
        };
    }
}
