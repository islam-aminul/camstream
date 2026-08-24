package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.media.FfmpegHls;
import online.camstream.agent.publish.HlsPublisher;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.services.s3.S3Client;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * Starts and stops ffmpeg pipelines to match what viewers are actually watching.
 *
 * Nothing runs by default. An idle site consumes no CPU on-premises and issues
 * no S3 requests, which is what makes the cost model work — the bill tracks
 * viewing, not camera count.
 */
public final class StreamManager implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(StreamManager.class);

    private record Pipeline(FfmpegHls ffmpeg, HlsPublisher publisher, Path directory, Instant startedAt) {}

    /** Restart backoff. A camera that is unreachable must not be hammered. */
    private static final Duration MIN_BACKOFF = Duration.ofSeconds(1);
    private static final Duration MAX_BACKOFF = Duration.ofSeconds(30);
    /** A pipeline alive this long is considered to have recovered. */
    private static final Duration HEALTHY_AFTER = Duration.ofSeconds(60);

    private final AgentConfig config;
    private final S3Client s3;
    private final Path workRoot;
    private final Map<String, CameraConfig> camerasById = new HashMap<>();
    private final Map<Rendition, Pipeline> active = new ConcurrentHashMap<>();
    private final Map<Rendition, Integer> consecutiveFailures = new ConcurrentHashMap<>();
    private final Map<Rendition, Instant> retryAfter = new ConcurrentHashMap<>();

    private volatile Instant lastInstruction = Instant.now();

    public StreamManager(AgentConfig config, S3Client s3) throws IOException {
        this.config = config;
        this.s3 = s3;
        this.workRoot = Files.createTempDirectory("camstream-");
        for (CameraConfig camera : config.cameras) {
            camerasById.put(camera.id, camera);
        }
    }

    /** Applies a desired state received from the control plane. */
    public synchronized void apply(Set<Rendition> desired) {
        lastInstruction = Instant.now();

        for (Rendition rendition : Set.copyOf(active.keySet())) {
            if (!desired.contains(rendition)) {
                stop(rendition);
            }
        }
        // Drop pending retries for anything no longer wanted, or a stopped
        // rendition would come back to life when its backoff elapsed.
        retryAfter.keySet().removeIf(rendition -> !desired.contains(rendition));
        consecutiveFailures.keySet().removeIf(rendition -> !desired.contains(rendition));

        for (Rendition rendition : desired) {
            if (!active.containsKey(rendition) && !retryAfter.containsKey(rendition)) {
                start(rendition);
            }
        }
    }

    /**
     * Uploads whatever ffmpeg has produced, restarts anything that died, and
     * shuts everything down if the control plane has gone quiet.
     */
    public void tick() {
        if (Duration.between(lastInstruction, Instant.now()).getSeconds() > config.idleShutdownSeconds
                && !active.isEmpty()) {
            log.info("no watch instruction for {}s — stopping all renditions", config.idleShutdownSeconds);
            stopAll();
            return;
        }

        for (Map.Entry<Rendition, Pipeline> entry : active.entrySet()) {
            Pipeline pipeline = entry.getValue();
            pipeline.publisher().sync();
            if (!pipeline.ffmpeg().isAlive()) {
                // Cameras drop connections routinely; restarting is normal
                // operation rather than an error path. Backoff keeps an
                // unreachable camera from being retried in a tight loop.
                Rendition rendition = entry.getKey();
                // A pipeline that ran for a while was healthy; treat this as a
                // fresh fault rather than compounding an old backoff, or a
                // camera that flaps once an hour ends up pinned at the cap.
                if (Duration.between(pipeline.startedAt(), Instant.now()).compareTo(HEALTHY_AFTER) > 0) {
                    consecutiveFailures.remove(rendition);
                }
                int failures = consecutiveFailures.merge(rendition, 1, Integer::sum);
                Duration wait = backoff(failures);
                log.warn("[{}] ffmpeg exited (attempt {}) — retrying in {}s",
                        rendition, failures, wait.toSeconds());
                stop(rendition);
                retryAfter.put(rendition, Instant.now().plus(wait));
            }
        }

        // Renditions that are still wanted but are waiting out a backoff.
        for (Map.Entry<Rendition, Instant> entry : Map.copyOf(retryAfter).entrySet()) {
            if (Instant.now().isAfter(entry.getValue())) {
                retryAfter.remove(entry.getKey());
                start(entry.getKey());
            }
        }
    }

    /** Exponential, capped: 1s, 2s, 4s ... 30s. */
    private static Duration backoff(int consecutiveFailures) {
        long seconds = MIN_BACKOFF.toSeconds() << Math.min(consecutiveFailures - 1, 16);
        return Duration.ofSeconds(Math.min(seconds, MAX_BACKOFF.toSeconds()));
    }

    private void start(Rendition rendition) {
        CameraConfig camera = camerasById.get(rendition.cameraId());
        if (camera == null) {
            log.warn("ignoring request for unknown camera {}", rendition.cameraId());
            return;
        }
        if (!camera.supports(rendition.profile())) {
            log.warn("[{}] camera has no {} stream configured", rendition, rendition.profile().key());
            return;
        }
        try {
            Path directory = Files.createDirectories(
                    workRoot.resolve(rendition.keySuffix().replace('/', java.io.File.separatorChar)));
            clean(directory);

            FfmpegHls ffmpeg = new FfmpegHls(config, camera, rendition, directory);
            HlsPublisher publisher = new HlsPublisher(
                    s3, config.bucket, config.keyPrefix() + rendition.keySuffix(), directory, rendition.toString());

            active.put(rendition, new Pipeline(ffmpeg, publisher, directory, Instant.now()));
            retryAfter.remove(rendition);
            log.info("[{}] publishing to s3://{}/{}", rendition, config.bucket,
                    config.keyPrefix() + rendition.keySuffix());
        } catch (IOException e) {
            log.error("[{}] could not start: {}", rendition, e.toString());
        }
    }

    private void stop(Rendition rendition) {
        Optional.ofNullable(active.remove(rendition)).ifPresent(pipeline -> {
            pipeline.ffmpeg().close();
            clean(pipeline.directory());
            log.info("[{}] stopped", rendition);
        });
    }

    private void stopAll() {
        for (Rendition rendition : Set.copyOf(active.keySet())) {
            stop(rendition);
        }
        retryAfter.clear();
        consecutiveFailures.clear();
    }

    /** Removes leftover segments so a restart never republishes a stale playlist. */
    private static void clean(Path directory) {
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (Stream<Path> entries = Files.walk(directory)) {
            entries.sorted(Comparator.reverseOrder())
                    .filter(p -> !p.equals(directory))
                    .forEach(p -> {
                        try {
                            Files.deleteIfExists(p);
                        } catch (IOException e) {
                            throw new UncheckedIOException(e);
                        }
                    });
        } catch (IOException | UncheckedIOException e) {
            log.debug("could not clean {}: {}", directory, e.toString());
        }
    }

    @Override
    public void close() {
        stopAll();
        clean(workRoot);
        try {
            Files.deleteIfExists(workRoot);
        } catch (IOException e) {
            log.debug("could not remove work directory", e);
        }
    }
}
