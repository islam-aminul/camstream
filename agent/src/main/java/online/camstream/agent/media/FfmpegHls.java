package online.camstream.agent.media;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * One ffmpeg process, producing plain HLS for a single camera rendition.
 *
 * The stream is copied, never re-encoded: no GPL codec is linked and no AVC
 * encoder licence is needed. It also means the agent runs comfortably on a
 * small on-premises box, since it is doing packaging rather than compression.
 *
 * Audio is discarded outright — CCTV rarely uses it, and dropping it avoids an
 * AAC dependency along with the licensing that carries.
 */
public final class FfmpegHls implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(FfmpegHls.class);

    private final Process process;
    private final Thread logPump;
    private final String label;

    /**
     * Distinguishes the output of one ffmpeg run from the next.
     *
     * Segment files are served with immutable cache headers, so a restart that
     * reused `seg_000000.m4s` would be answered from the CDN with the previous
     * run's video until that cache entry expired. A per-run prefix makes every
     * object genuinely write-once.
     */
    private final String runId;

    public FfmpegHls(AgentConfig config, CameraConfig camera, StreamProfile profile, Path outputDir)
            throws IOException {
        this.label = camera.id + "/" + profile.key();
        this.runId = Long.toString(System.currentTimeMillis(), 36);

        List<String> command = new ArrayList<>(List.of(
                config.ffmpegPath,
                "-nostdin",
                "-hide_banner",
                "-loglevel", "warning",
                // TCP where the camera supports it: UDP packet loss becomes
                // macroblocking that is then baked into every viewer's stream.
                "-rtsp_transport", camera.rtspTransport,
                "-timeout", "5000000",
                "-i", camera.urlFor(profile),
                "-an",
                "-c:v", "copy",
                "-f", "hls",
                "-hls_time", String.valueOf(config.segmentDurationMs / 1000.0),
                "-hls_list_size", String.valueOf(config.playlistWindow),
                // delete_segments keeps the working directory bounded; temp_file
                // stops the uploader seeing half-written segments.
                "-hls_flags", "delete_segments+independent_segments+program_date_time+temp_file",
                "-hls_segment_type", "fmp4",
                "-hls_fmp4_init_filename", runId + "_init.mp4",
                "-hls_segment_filename", outputDir.resolve(runId + "_%06d.m4s").toString(),
                outputDir.resolve("index.m3u8").toString()));

        log.info("[{}] starting ffmpeg", label);
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.redirectErrorStream(true);
        this.process = builder.start();

        this.logPump = Thread.ofVirtual().name("ffmpeg-log-" + label).start(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    log.warn("[{}] ffmpeg: {}", label, line);
                }
            } catch (IOException e) {
                // Process ended; nothing useful left to read.
            }
        });
    }

    public boolean isAlive() {
        return process.isAlive();
    }

    @Override
    public void close() {
        if (process.isAlive()) {
            log.info("[{}] stopping ffmpeg", label);
            process.destroy();
            try {
                if (!process.waitFor(5, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
        logPump.interrupt();
    }
}
