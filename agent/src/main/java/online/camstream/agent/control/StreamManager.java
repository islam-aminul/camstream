package online.camstream.agent.control;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.media.FfmpegHls;
import online.camstream.agent.health.ResourceMonitor;
import online.camstream.agent.publish.HlsPublisher;
import online.camstream.agent.publish.MasterPlaylist;
import online.camstream.agent.supervise.Backoff;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
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

    /** Restart policy, shared with the Supervisor so the agent retries uniformly. */
    private static final Duration MIN_BACKOFF = Duration.ofSeconds(1);
    private static final Duration MAX_BACKOFF = Duration.ofSeconds(30);
    /** A pipeline alive this long is considered to have recovered. */
    private static final Duration HEALTHY_AFTER = Duration.ofSeconds(60);
    /**
     * Retry interval when the camera refuses us outright.
     *
     * Bad credentials will not become good in thirty seconds, and a camera that
     * has run out of RTSP sessions needs the pressure taken off before it can
     * release them — so this waits rather than hammering.
     */
    private static final Duration REFUSED_BACKOFF = Duration.ofMinutes(5);

    private final AgentConfig config;
    private final S3Client s3;
    private final Path workRoot;
    private final CameraRegistry registry;
    private final Map<Rendition, Pipeline> active = new ConcurrentHashMap<>();
    private final Map<Rendition, Backoff> backoffs = new ConcurrentHashMap<>();
    private final Map<Rendition, Instant> retryAfter = new ConcurrentHashMap<>();
    /** cameraId -> the rendition set the current master playlist describes. */
    private final Map<String, String> publishedLadders = new ConcurrentHashMap<>();
    /** Renditions whose next pipeline follows an encoder restart. */
    private final java.util.Set<Rendition> restartedRenditions = ConcurrentHashMap.newKeySet();
    /** Transcodes refused because the agent is already at its concurrency cap. */
    private final java.util.Set<Rendition> declined = ConcurrentHashMap.newKeySet();

    private volatile Instant lastInstruction = Instant.now();

    public StreamManager(AgentConfig config, S3Client s3, CameraRegistry registry) throws IOException {
        this.config = config;
        this.s3 = s3;
        this.registry = registry;
        this.workRoot = Files.createTempDirectory("camstream-");
    }

    /** How many renditions are being published right now. */
    public int publishing() {
        return active.size();
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
        backoffs.keySet().removeIf(rendition -> !desired.contains(rendition));

        // Copies first, then transcodes up to the cap. Ordering matters: a
        // copy costs almost nothing and must never be crowded out by an encode
        // that arrived earlier in the set, or one viewer opening an HEVC
        // camera would stop cameras that were working perfectly well.
        List<Rendition> copies = new java.util.ArrayList<>();
        List<Rendition> transcodes = new java.util.ArrayList<>();
        for (Rendition rendition : desired) {
            if (active.containsKey(rendition) || retryAfter.containsKey(rendition)) {
                continue;
            }
            (needsEncoder(rendition) ? transcodes : copies).add(rendition);
        }
        for (Rendition rendition : copies) {
            start(rendition);
        }

        Split split = withinCap(transcodes, runningTranscodes(),
                config.effectiveMaxConcurrentTranscodes());
        for (Rendition rendition : split.start()) {
            declined.remove(rendition);
            start(rendition);
        }
        for (Rendition rendition : split.refuse()) {
            if (declined.add(rendition)) {
                log.warn("[{}] not transcoding: this agent allows {} at a time and they are all in use",
                        rendition, config.effectiveMaxConcurrentTranscodes());
            }
        }
        declined.retainAll(desired);
    }

    /** New transcodes split into those that fit the cap and those that do not. */
    record Split(List<Rendition> start, List<Rendition> refuse) {}

    /**
     * Decides which of the transcodes not yet running can be afforded.
     *
     * The control plane already declines what it will not grant, so in normal
     * operation everything here fits. This is the copy that does not depend on
     * the control plane being reachable, correct, or honest — it owns the CPU,
     * and a bug or a stale instruction upstream must not be able to take the
     * box down through it.
     *
     * Renditions already running are counted, never re-evaluated: taking a
     * slot back from a stream somebody is watching is worse than being one
     * over the limit until it stops on its own.
     */
    static Split withinCap(List<Rendition> transcodes, int alreadyRunning, int cap) {
        // Stable order, so which transcode gets the slot does not change from
        // one instruction to the next and flap between two cameras.
        List<Rendition> ordered = new java.util.ArrayList<>(transcodes);
        ordered.sort(java.util.Comparator.comparing(Rendition::toString));

        int budget = Math.max(0, cap - alreadyRunning);
        int take = Math.min(budget, ordered.size());
        return new Split(List.copyOf(ordered.subList(0, take)),
                List.copyOf(ordered.subList(take, ordered.size())));
    }

    /** Whether this rendition would spend CPU rather than copy bytes. */
    private boolean needsEncoder(Rendition rendition) {
        if (rendition.variant() != Variant.H264) {
            return false;
        }
        CameraConfig camera = registry.get(rendition.cameraId());
        // An unknown camera is not started at all, so it costs no slot.
        return camera != null && !camera.browserPlayable();
    }

    /** Watches how well the uplink keeps up; attached before any stream starts. */
    public void meter(ResourceMonitor monitor) {
        this.monitor = monitor;
    }

    private ResourceMonitor monitor;

    public int runningTranscodes() {
        return (int) active.keySet().stream().filter(this::needsEncoder).count();
    }

    /**
     * Renditions the cap turned away.
     *
     * Reported upward so a viewer can be told their transcode is waiting for a
     * slot, rather than being shown a stream that silently never starts.
     */
    public Set<Rendition> declined() {
        return Set.copyOf(declined);
    }

    /**
     * Uploads whatever ffmpeg has produced, restarts anything that died, and
     * shuts everything down if the control plane has gone quiet.
     *
     * Synchronized on the same monitor as {@link #apply}, which it was not.
     * ConcurrentHashMap makes each operation atomic and does nothing for the
     * sequences: tick() would stop a dead rendition and be interrupted before
     * recording its retry, apply() would find it in neither map and start it,
     * and the retry would then start it a second time — replacing the map
     * entry without closing the first ffmpeg. The orphan keeps its RTSP
     * session, and a camera with a handful of slots then refuses everyone,
     * including this agent when it restarts. That is the same failure the
     * shutdown hook exists to prevent, reachable during normal operation.
     */
    public synchronized void tick() {
        if (Duration.between(lastInstruction, Instant.now()).getSeconds() > config.idleShutdownSeconds
                && !active.isEmpty()) {
            log.info("no watch instruction for {}s — stopping all renditions", config.idleShutdownSeconds);
            stopAll();
            return;
        }

        publishMasterPlaylists();

        for (Map.Entry<Rendition, Pipeline> entry : active.entrySet()) {
            Pipeline pipeline = entry.getValue();
            pipeline.publisher().sync();
            if (!pipeline.ffmpeg().isAlive()) {
                // Cameras drop connections routinely; restarting is normal
                // operation rather than an error path. Backoff keeps an
                // unreachable camera from being retried in a tight loop.
                Rendition rendition = entry.getKey();
                Backoff backoff = backoffs.computeIfAbsent(
                        rendition, r -> new Backoff(MIN_BACKOFF, MAX_BACKOFF, HEALTHY_AFTER));
                Duration wait = backoff.failed();
                if (pipeline.ffmpeg().wasRefused()) {
                    wait = REFUSED_BACKOFF;
                    log.warn("[{}] the camera refused the connection — check the credentials, or it may "
                            + "have run out of RTSP sessions. Retrying in {}s.", rendition, wait.toSeconds());
                } else {
                    log.warn("[{}] ffmpeg exited (attempt {}) — retrying in {}s",
                            rendition, backoff.consecutiveFailures(), wait.toSeconds());
                }
                // Carried into the next pipeline so the playlist marks where
                // the timeline actually broke.
                restartedRenditions.add(rendition);
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

    /**
     * Offers an ABR ladder for any camera currently publishing more than one
     * rendition — in practice the camera a viewer has opened. Written only when
     * the set changes, since it is a small object on the no-cache path.
     */
    private void publishMasterPlaylists() {
        Map<String, List<Rendition>> byCamera = new java.util.HashMap<>();
        for (Rendition rendition : active.keySet()) {
            byCamera.computeIfAbsent(rendition.cameraId(), id -> new java.util.ArrayList<>()).add(rendition);
        }

        for (Map.Entry<String, List<Rendition>> entry : byCamera.entrySet()) {
            String cameraId = entry.getKey();
            List<Rendition> renditions = entry.getValue();
            String signature = renditions.stream().map(Rendition::toString).sorted().collect(Collectors.joining(","));
            if (signature.equals(publishedLadders.get(cameraId))) {
                continue;
            }

            CameraConfig camera = registry.get(cameraId);
            if (camera == null) {
                continue;
            }
            List<MasterPlaylist.Rung> rungs = new java.util.ArrayList<>();
            for (Rendition rendition : renditions) {
                Integer width = camera.widthFor(rendition.profile());
                Integer height = camera.heightFor(rendition.profile());
                if (width == null || height == null) {
                    continue;
                }
                // Each rung must declare what it actually carries. A
                // transcoded rendition is H.264 whatever the camera emits, and
                // labelling it with the source codec makes a player that cannot
                // decode that codec reject the very rung produced for it.
                boolean transcoded = rendition.variant() == Variant.H264 && !camera.browserPlayable();
                String rungCodec = transcoded ? "h264" : camera.sourceCodec;
                // A transcoded rung is whatever the encoder was told to emit —
                // 8-bit Main — not whatever the camera happened to send in.
                String rungProfile = transcoded ? "Main" : camera.sourceCodecProfile;
                Integer rungLevel = transcoded ? null : camera.sourceCodecLevel;
                rungs.add(new MasterPlaylist.Rung(
                        rendition.profile(),
                        // Relative to the camera prefix, where master.m3u8 sits.
                        rendition.keySuffix().substring(cameraId.length() + 1) + "index.m3u8",
                        width, height,
                        MasterPlaylist.estimateBandwidth(width, height, camera.bitrateFor(rendition.profile())),
                        rungCodec, rungProfile, rungLevel));
            }

            if (MasterPlaylist.publish(s3, config.bucket, config.keyPrefix() + cameraId + "/", rungs)) {
                publishedLadders.put(cameraId, signature);
                log.info("[{}] published an ABR ladder with {} rungs", cameraId, rungs.size());
            } else {
                publishedLadders.remove(cameraId);
            }
        }
        // A camera whose last rendition stopped never entered the loop above,
        // so its master would otherwise survive every manifest it names —
        // which is the state a returning viewer loads first.
        for (String cameraId : Set.copyOf(publishedLadders.keySet())) {
            if (!byCamera.containsKey(cameraId)) {
                MasterPlaylist.remove(s3, config.bucket, config.keyPrefix() + cameraId + "/");
                publishedLadders.remove(cameraId);
                log.info("[{}] retired the ABR ladder", cameraId);
            }
        }
    }

    private void start(Rendition rendition) {
        CameraConfig camera = registry.get(rendition.cameraId());
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
            // Clear the published manifest too, not just the local files.
            // stop() retires a playlist on the way down, but an agent that was
            // killed, crashed or lost power never runs it — and the playlist it
            // leaves behind still resolves, because the segments it names live
            // until the bucket's lifecycle rule expires them a day later. A
            // viewer opening this camera then watches yesterday's footage
            // believing it is live, which is the one failure worse than the
            // stream not starting at all. The new pipeline republishes within a
            // segment; until it does, a 404 is what the player already reads as
            // "starting".
            retirePlaylist(rendition);

            FfmpegHls ffmpeg = new FfmpegHls(config, camera, rendition, directory);
            HlsPublisher publisher = new HlsPublisher(
                    s3, config.bucket, config.keyPrefix() + rendition.keySuffix(), directory,
                    rendition.toString(), config.playlistWindow);
            // Every publisher feeds the same meter, so the throughput figure is
            // the whole agent's upload rather than one stream's.
            if (monitor != null) {
                publisher.meter(monitor);
            }

            // So a playlist built without ffmpeg's own still carries the right
            // nominal duration rather than a guess.
            publisher.segmentSeconds(config.segmentDurationMs / 1000.0);

            if (restartedRenditions.remove(rendition)) {
                publisher.encoderRestarted();
            }
            // Belt and braces against the race above ever reappearing: a
            // displaced pipeline is closed rather than leaked.
            Pipeline displaced = active.put(rendition, new Pipeline(ffmpeg, publisher, directory, Instant.now()));
            if (displaced != null) {
                log.warn("[{}] a pipeline was already running — closing the previous one", rendition);
                displaced.ffmpeg().close();
            }
            retryAfter.remove(rendition);
            backoffs.computeIfAbsent(rendition, r -> new Backoff(MIN_BACKOFF, MAX_BACKOFF, HEALTHY_AFTER))
                    .started();
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
            retirePlaylist(rendition);
            log.info("[{}] stopped", rendition);
        });
    }

    /**
     * Removes a rendition's published playlist.
     *
     * The segments it names stay in the bucket until their lifecycle rule
     * expires them, and the playlist would otherwise go on describing them as
     * live. A viewer opening this camera an hour later loaded that playlist and
     * watched hour-old footage while waiting for the encoder to start — the
     * stream looked like it was working, and was showing the wrong day.
     *
     * Deleting it means the manifest 404s until real segments exist, which the
     * player already understands as "starting".
     *
     * Called on both edges, not just the way down. Doing it only in stop()
     * left every playlist behind whenever the process did not shut down
     * cleanly — a kill, a crash, a power cut at the site — and those are
     * exactly the cases where nobody is watching to notice. One DELETE per
     * start and one per stop is a rounding error against a segment per second.
     */
    private void retirePlaylist(Rendition rendition) {
        String key = config.keyPrefix() + rendition.keySuffix() + "index.m3u8";
        try {
            s3.deleteObject(DeleteObjectRequest.builder().bucket(config.bucket).key(key).build());
        } catch (RuntimeException e) {
            // A playlist left behind is untidy, not fatal; the next start
            // overwrites it. Never let this fail a shutdown.
            log.debug("could not remove {}: {}", key, e.toString());
        }
    }

    private void stopAll() {
        for (Rendition rendition : Set.copyOf(active.keySet())) {
            stop(rendition);
        }
        retryAfter.clear();
        backoffs.clear();
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
