package online.camstream.agent.media;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.control.Rendition;
import online.camstream.agent.control.Variant;
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
     * Set when the camera refused us rather than failed to answer.
     *
     * A 401 or 403 from RTSP is not a transient fault: the credentials are
     * wrong, or the camera has run out of session slots. Retrying every few
     * seconds cannot fix either, and against a camera that leaks sessions on an
     * abrupt disconnect it is what prevents recovery.
     */
    private volatile boolean refused;

    /**
     * Distinguishes the output of one ffmpeg run from the next.
     *
     * Segment files are served with immutable cache headers, so a restart that
     * reused `seg_000000.m4s` would be answered from the CDN with the previous
     * run's video until that cache entry expired. A per-run prefix makes every
     * object genuinely write-once.
     */
    private final String runId;

    /**
     * Runs ffmpeg with the segment directory as its working directory.
     *
     * Everything else here is an absolute path, but the initialisation segment
     * cannot be: ffmpeg copies `hls_fmp4_init_filename` verbatim into the
     * playlist as the EXT-X-MAP URI, so an absolute path there would send every
     * viewer to a URL under the local disk. It has to stay a bare name, and a
     * bare name is resolved against the working directory - which was wherever
     * the agent happened to be started from.
     *
     * So the segments were uploaded, the playlist was uploaded, the playlist
     * named an initialisation segment, and that one file was written next to
     * the service instead. Every viewer fetched it, got 403 because it was
     * never in the bucket, and stalled at readyState 0 with a complete stream
     * behind it. On this machine eleven of them had piled up in C:\ProgramData.
     *
     * Pointing the working directory at the output makes the bare name land
     * where the uploader is looking, and leaves the URI relative.
     */
    static ProcessBuilder processIn(List<String> command, Path outputDir) {
        return new ProcessBuilder(command).directory(outputDir.toFile());
    }

    public FfmpegHls(AgentConfig config, CameraConfig camera, Rendition rendition, Path outputDir)
            throws IOException {
        StreamProfile profile = rendition.profile();
        this.label = rendition.toString();
        this.runId = Long.toString(System.currentTimeMillis(), 36);

        double segmentSeconds = config.segmentDurationMs / 1000.0;
        EncoderProfile encoder = resolveEncoder(camera, rendition);

        List<String> command = new ArrayList<>();
        command.add(config.ffmpegPath);
        command.addAll(List.of("-nostdin", "-hide_banner", "-loglevel", "warning"));
        // Hardware contexts must be created before the input is opened.
        command.addAll(EncoderArguments.beforeInput(encoder, camera.encoderDevice));
        command.addAll(List.of(
                // TCP where the camera supports it: UDP packet loss becomes
                // macroblocking that is then baked into every viewer's stream.
                "-rtsp_transport", camera.rtspTransport,
                "-timeout", "5000000",
                "-i", camera.urlFor(profile),
                "-an"));
        command.addAll(EncoderArguments.video(
                encoder, camera.encoderArgs, camera.encoderBitrateKbps, camera.encoderMaxHeight, segmentSeconds));
        command.addAll(List.of(
                "-f", "hls",
                "-hls_time", String.valueOf(segmentSeconds),
                // Short first segments, so a tile has something to play sooner.
                // ffmpeg grows them to hls_time on its own after this much
                // media, and cuts at the first keyframe past the target - so a
                // value under the camera's keyframe interval produces exactly
                // one group of pictures rather than two.
                "-hls_init_time", String.valueOf(config.initialSegmentDurationMs / 1000.0),
                "-hls_list_size", String.valueOf(config.playlistWindow),
                // delete_segments keeps the working directory bounded; temp_file
                // stops the uploader seeing half-written segments.
                "-hls_flags", "delete_segments+independent_segments+program_date_time+temp_file",
                "-hls_segment_type", "fmp4",
                "-hls_fmp4_init_filename", runId + "_init.mp4",
                "-hls_segment_filename", outputDir.resolve(runId + "_%06d.m4s").toString(),
                outputDir.resolve("index.m3u8").toString()));

        log.info("[{}] starting ffmpeg ({})", label, encoder.isTranscode() ? encoder.key() : "stream copy");
        ProcessBuilder builder = processIn(command, outputDir);
        builder.redirectErrorStream(true);
        this.process = builder.start();

        this.logPump = Thread.ofVirtual().name("ffmpeg-log-" + label).start(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.contains("401 Unauthorized") || line.contains("403 Forbidden")) {
                        refused = true;
                    }
                    log.warn("[{}] ffmpeg: {}", label, redact(line));
                }
            } catch (IOException e) {
                // Process ended; nothing useful left to read.
            }
        });
    }

    /**
     * A transcode only happens when one is genuinely needed: the viewer asked
     * for H.264, the camera does not already produce it, and an encoder is
     * configured. Anything else copies.
     */
    private static EncoderProfile resolveEncoder(CameraConfig camera, Rendition rendition) {
        if (rendition.variant() == Variant.SOURCE) {
            return EncoderProfile.COPY;
        }
        // Deliberately not "is it already H.264": High 10 is H.264 and no
        // browser decodes it, so a camera emitting it needs the transcode just
        // as much as an HEVC one. Copying because the codec name matched left
        // the viewer with the same unplayable stream they asked us to fix.
        if (camera.browserPlayable()) {
            return EncoderProfile.COPY;
        }
        EncoderProfile configured = EncoderProfile.fromKey(camera.encoder);
        if (configured == EncoderProfile.COPY) {
            log.warn("[{}] H.264 requested but no encoder configured for camera {} — copying instead",
                    rendition, camera.id);
        }
        return configured;
    }

    /**
     * Removes any userinfo from a URL before it reaches the log.
     *
     * ffmpeg echoes the input URL in several error paths, and that URL is
     * rtsp://user:password@host/path. The whole credential design turns on
     * plaintext existing in exactly two places — the administrator's browser
     * tab and this process's memory — and journald or the WinSW log directory
     * was quietly becoming a third.
     */
    static String redact(String line) {
        return line == null ? null : line.replaceAll("([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s@]*@", "$1<redacted>@");
    }

    public boolean isAlive() {
        return process.isAlive();
    }

    /** Whether the camera actively refused the connection. */
    public boolean wasRefused() {
        return refused;
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
