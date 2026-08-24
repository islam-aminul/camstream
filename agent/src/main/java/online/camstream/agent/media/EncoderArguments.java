package online.camstream.agent.media;

import java.util.ArrayList;
import java.util.List;

/**
 * Translates an {@link EncoderProfile} into ffmpeg arguments.
 *
 * Hardware encoders differ in more than the codec name: VA-API and QSV need a
 * device initialised before the input is opened and frames uploaded to it,
 * while NVENC, AMF and V4L2 take frames from system memory. Keeping that
 * knowledge here means {@link FfmpegHls} only assembles a command.
 */
final class EncoderArguments {

    private EncoderArguments() {
    }

    /**
     * Arguments that must precede {@code -i}. Hardware contexts have to exist
     * before the decoder is set up, so they cannot go with the output options.
     */
    static List<String> beforeInput(EncoderProfile profile, String device) {
        return switch (profile) {
            case VAAPI -> List.of("-vaapi_device", device == null ? "/dev/dri/renderD128" : device);
            case QSV -> List.of("-init_hw_device", "qsv=hw", "-filter_hw_device", "hw");
            case NVENC -> List.of("-hwaccel", "cuda");
            default -> List.of();
        };
    }

    /**
     * Video output arguments.
     *
     * @param segmentSeconds used to force keyframes onto segment boundaries.
     *                       Transcoding is the one case where the agent controls
     *                       GOP structure, so segment duration finally becomes
     *                       exact rather than dependent on the camera's setting.
     */
    static List<String> video(
            EncoderProfile profile,
            List<String> customArgs,
            Integer bitrateKbps,
            Integer maxHeight,
            double segmentSeconds) {

        if (profile == EncoderProfile.COPY) {
            return List.of("-c:v", "copy");
        }
        if (profile == EncoderProfile.CUSTOM) {
            if (customArgs == null || customArgs.isEmpty()) {
                throw new IllegalArgumentException("encoder \"custom\" requires encoderArgs");
            }
            return List.copyOf(customArgs);
        }

        List<String> args = new ArrayList<>();
        String filter = scaleFilter(profile, maxHeight);
        if (filter != null) {
            args.add("-vf");
            args.add(filter);
        }

        args.add("-c:v");
        args.add(profile.encoderName());

        int bitrate = bitrateKbps == null ? 2000 : bitrateKbps;
        args.add("-b:v");
        args.add(bitrate + "k");
        args.add("-maxrate");
        args.add(bitrate + "k");
        args.add("-bufsize");
        args.add((bitrate * 2) + "k");

        // Every segment must open on a keyframe or the HLS muxer cannot cut
        // where it was asked to.
        args.add("-force_key_frames");
        args.add("expr:gte(t,n_forced*" + segmentSeconds + ")");

        switch (profile) {
            case NVENC -> {
                // p4 balances quality against latency; surveillance does not
                // benefit from the slower presets.
                args.addAll(List.of("-preset", "p4", "-tune", "ll", "-rc", "cbr"));
            }
            case V4L2M2M -> {
                // The Pi's encoder stalls under the default buffer count.
                args.addAll(List.of("-num_output_buffers", "32", "-num_capture_buffers", "16"));
            }
            case QSV -> args.addAll(List.of("-preset", "veryfast", "-low_power", "1"));
            case AMF -> args.addAll(List.of("-usage", "lowlatency", "-quality", "speed"));
            case VIDEOTOOLBOX -> args.addAll(List.of("-realtime", "1"));
            default -> {
            }
        }
        return args;
    }

    /**
     * VA-API and QSV encode from GPU memory, so frames must be uploaded even
     * when no rescaling is wanted; the others take ordinary frames.
     */
    private static String scaleFilter(EncoderProfile profile, Integer maxHeight) {
        boolean scaling = maxHeight != null && maxHeight > 0;
        return switch (profile) {
            case VAAPI -> scaling
                    ? "format=nv12,hwupload,scale_vaapi=w=-2:h=" + maxHeight
                    : "format=nv12,hwupload";
            case QSV -> scaling
                    ? "format=nv12,hwupload=extra_hw_frames=64,scale_qsv=w=-2:h=" + maxHeight
                    : "format=nv12,hwupload=extra_hw_frames=64";
            default -> scaling ? "scale=-2:" + maxHeight : null;
        };
    }
}
