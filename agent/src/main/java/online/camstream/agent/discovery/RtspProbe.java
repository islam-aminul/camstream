package online.camstream.agent.discovery;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Confirms an RTSP URL actually plays, and reports what codec it carries.
 *
 * ONVIF's advertised encoding is frequently wrong — a profile labelled H264 may
 * deliver H.265 after a firmware update — and the codec decides whether viewers
 * need a transcode. So the stream is asked directly rather than believed.
 *
 * This uses the external ffprobe binary. It deliberately does not use a bundled
 * media library: the usual Java option ships a GPL FFmpeg build.
 */
final class RtspProbe {

    private static final Logger log = LoggerFactory.getLogger(RtspProbe.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int TIMEOUT_SECONDS = 15;

    /**
     * What the stream actually carries.
     *
     * Profile and level matter as much as the codec name: a browser rejects
     * H.264 High 10 as firmly as it rejects HEVC, and a player told only
     * "h264" will accept the stream and then fail to decode it silently.
     */
    record Result(String codec, Integer width, Integer height, Integer fps,
                  String profile, Integer level) {}

    private final String ffprobePath;

    RtspProbe(String ffprobePath) {
        this.ffprobePath = ffprobePath;
    }

    /** Returns null when the stream could not be opened or carries no video. */
    Result probe(String rtspUrl, String transport) {
        List<String> command = List.of(
                ffprobePath,
                "-v", "error",
                "-rtsp_transport", transport,
                // Bound the wait: an unreachable camera must not stall a scan.
                "-timeout", String.valueOf(TIMEOUT_SECONDS * 1_000_000L),
                "-select_streams", "v:0",
                "-show_entries", "stream=codec_name,width,height,avg_frame_rate,profile,level",
                "-of", "json",
                rtspUrl);
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.redirectErrorStream(false);
            Process process = builder.start();
            byte[] stdout = drain(process.getInputStream());
            if (!process.waitFor(TIMEOUT_SECONDS + 5, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return null;
            }
            if (process.exitValue() != 0) {
                return null;
            }
            JsonNode stream = MAPPER.readTree(stdout).path("streams").path(0);
            if (stream.isMissingNode() || stream.path("codec_name").isMissingNode()) {
                return null;
            }
            return new Result(
                    stream.path("codec_name").asText(null),
                    stream.hasNonNull("width") ? stream.get("width").asInt() : null,
                    stream.hasNonNull("height") ? stream.get("height").asInt() : null,
                    parseFrameRate(stream.path("avg_frame_rate").asText(null)),
                    stream.hasNonNull("profile") ? stream.get("profile").asText() : null,
                    // ffprobe reports -99 when the level is unknown.
                    stream.hasNonNull("level") && stream.get("level").asInt() > 0
                            ? stream.get("level").asInt() : null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            log.debug("ffprobe failed for a stream on this camera: {}", e.toString());
            return null;
        }
    }

    /** ffprobe reports frame rate as a rational, e.g. "30000/1001". */
    private static Integer parseFrameRate(String rational) {
        if (rational == null || !rational.contains("/")) {
            return null;
        }
        String[] parts = rational.split("/", 2);
        try {
            double denominator = Double.parseDouble(parts[1]);
            if (denominator == 0) {
                return null;
            }
            return (int) Math.round(Double.parseDouble(parts[0]) / denominator);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static byte[] drain(InputStream in) throws Exception {
        try (in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            in.transferTo(out);
            return out.toByteArray();
        }
    }
}
