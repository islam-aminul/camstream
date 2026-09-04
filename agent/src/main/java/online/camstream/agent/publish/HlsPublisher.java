package online.camstream.agent.publish;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.sync.RequestBody;
import online.camstream.agent.health.ResourceMonitor;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Mirrors one ffmpeg output directory into S3.
 *
 * Ordering matters more than speed here: a playlist that names a segment which
 * has not been uploaded yet makes the player 404 and stall. Media is therefore
 * always uploaded before the playlist that references it.
 *
 * Segments are never deleted from S3. The bucket's lifecycle rule expires them,
 * which is both cheaper than issuing DELETEs and impossible to get wrong.
 */
public final class HlsPublisher {

    private static final Logger log = LoggerFactory.getLogger(HlsPublisher.class);

    private static final String PLAYLIST = "index.m3u8";

    /**
     * By name: ffmpeg never rewrites a segment once it is closed.
     *
     * Bounded, because this used to be a plain HashSet that was only ever
     * added to. At two-second segments a stable camera adds some forty
     * thousand names a day, and stable is the normal case — a pipeline only
     * restarts when its camera drops. ffmpeg has already deleted anything
     * older than the playlist window, so remembering a few multiples of it is
     * ample to avoid re-uploading.
     */
    private final Set<String> uploaded = java.util.Collections.newSetFromMap(
            new java.util.LinkedHashMap<>() {
                @Override
                protected boolean removeEldestEntry(java.util.Map.Entry<String, Boolean> eldest) {
                    return size() > uploadedMemory;
                }
            });

    /** How many segment names to remember. Set from the playlist window. */
    private int uploadedMemory = 64;

    /**
     * Media that ffmpeg never deletes, and which therefore must never be
     * forgotten.
     *
     * The bound above is safe for segments precisely because ffmpeg removes
     * them: a name that ages out of the set has already left the directory, so
     * it is never listed again. The init segment breaks that assumption. It is
     * written once and stays for the life of the run, so when its name aged out
     * it looked unuploaded and was sent again — once every uploadedMemory
     * segments, for as long as anybody watched.
     *
     * Small in bytes and invisible in behaviour, which is why it survived: the
     * only trace is the object's last-modified time marching forward on a file
     * served as immutable. At two-second segments it is roughly a thousand
     * pointless requests a day per stream.
     */
    private final Set<String> permanent = new java.util.HashSet<>();

    private final S3Client s3;
    private final String bucket;
    private final String keyPrefix;
    private final Path directory;
    private final String label;

    private byte[] lastPlaylist;
    /** Said once, not once a sweep, when falling back to our own segment list. */
    private boolean synthesised;
    /** Nominal segment length, used only when ffmpeg's durations are unavailable. */
    private double segmentSeconds = 4.0;
    private final PlaylistBuilder playlist;

    /**
     * Where upload throughput is recorded, when anyone is listening.
     *
     * Measured here because this is the one place bytes actually leave the
     * building. Timing the uploads the agent is already doing costs nothing and
     * measures the connection under its real load, which a speed test run on an
     * idle link does not.
     */
    private ResourceMonitor monitor;

    public HlsPublisher(S3Client s3, String bucket, String keyPrefix, Path directory, String label,
                        int windowSize) {
        this(s3, bucket, keyPrefix, directory, label, new PlaylistBuilder(windowSize));
        // Several windows' worth: ffmpeg has already deleted anything older,
        // so this only has to be long enough not to re-upload.
        this.uploadedMemory = Math.max(32, windowSize * 8);
    }

    HlsPublisher(S3Client s3, String bucket, String keyPrefix, Path directory, String label,
                 PlaylistBuilder playlist) {
        this.playlist = playlist;
        this.s3 = s3;
        this.bucket = bucket;
        this.keyPrefix = keyPrefix.endsWith("/") ? keyPrefix : keyPrefix + "/";
        this.directory = directory;
        this.label = label;
    }


    /**
     * Signals that ffmpeg restarted, so the next segment carries a
     * discontinuity rather than silently continuing a broken timeline.
     */
    public void encoderRestarted() {
        playlist.encoderRestarted();
    }

    /**
     * Uploads whatever is new since the last call. Safe to call on a tight
     * timer; it does nothing when ffmpeg has not produced anything.
     */
    public void sync() {
        try {
            uploadMediaFirst();
            uploadPlaylistIfChanged();
        } catch (IOException e) {
            log.warn("[{}] could not read ffmpeg output: {}", label, e.toString());
        } catch (RuntimeException e) {
            // A failed upload is recoverable — the next tick retries, and the
            // player tolerates a brief gap better than the agent dying.
            log.warn("[{}] upload failed: {}", label, e.toString());
        }
    }

    /**
     * ffmpeg's own naming for the fMP4 initialisation segment.
     *
     * Named in one place because two behaviours depend on it: the playlist
     * points at it with EXT-X-MAP, and the uploader must never forget it.
     */
    private static boolean isInitSegment(String name) {
        return name.endsWith("_init.mp4");
    }

    private void uploadMediaFirst() throws IOException {
        if (!Files.isDirectory(directory)) {
            return;
        }
        List<Path> media;
        try (Stream<Path> entries = Files.list(directory)) {
            media = entries
                    .filter(Files::isRegularFile)
                    .filter(p -> {
                        String name = p.getFileName().toString();
                        return (name.endsWith(".mp4") || name.endsWith(".m4s"))
                                && !uploaded.contains(name) && !permanent.contains(name);
                    })
                    // Segment names are zero-padded, so lexical order is
                    // chronological — upload oldest first.
                    .sorted()
                    .toList();
        }

        for (Path file : media) {
            String name = file.getFileName().toString();
            byte[] content;
            try {
                content = Files.readAllBytes(file);
            } catch (IOException e) {
                // ffmpeg deleted it between listing and reading; harmless.
                continue;
            }
            if (content.length == 0) {
                continue;
            }
            put(name, content, "video/mp4", "public, max-age=31536000, immutable");
            // The init segment outlives every window, so it is remembered
            // outright rather than in the bounded set.
            if (isInitSegment(name)) {
                permanent.add(name);
            } else {
                uploaded.add(name);
            }
        }
    }

    /**
     * Publishes our own playlist, built from what ffmpeg reports.
     *
     * ffmpeg owns the durations; the sequence, the window and the continuity
     * markers are ours, so that an encoder restart does not rewind the stream
     * a viewer is already watching.
     */
    private void uploadPlaylistIfChanged() throws IOException {
        Path source = directory.resolve(PLAYLIST);
        String reported = Files.isRegularFile(source) ? Files.readString(source) : "";

        List<PlaylistBuilder.Segment> observed = reported.isBlank()
                ? List.of() : PlaylistBuilder.parse(reported);

        if (observed.isEmpty()) {
            // ffmpeg's own playlist could not be used - it is not there yet, it
            // is mid-rename, or it holds nothing we recognise. That used to end
            // the method, which meant segments were uploaded and no playlist
            // ever named them: the stream existed in the bucket and no player
            // could find it, and nothing said so because returning quietly is
            // not an error.
            //
            // The playlist is ours to write. ffmpeg owns the exact durations,
            // so they are preferred when available, but their absence is no
            // reason to publish nothing when the segments are sitting here.
            observed = segmentsOnDisk();
            if (!observed.isEmpty() && !synthesised) {
                synthesised = true;
                log.info("[{}] ffmpeg's playlist is unreadable ({}); "
                        + "building one from the {} segment(s) already published",
                        label,
                        Files.isRegularFile(source) ? "present but unparsed" : "absent",
                        observed.size());
            }
        }

        if (observed.isEmpty()) {
            return;
        }

        String init = reported.isBlank() ? initOnDisk() : PlaylistBuilder.parseInit(reported);
        if (init != null) {
            playlist.setInitSegment(init);
        }
        playlist.observe(observed);
        if (playlist.isEmpty()) {
            return;
        }

        byte[] content = playlist.render().getBytes(StandardCharsets.UTF_8);
        if (Arrays.equals(content, lastPlaylist)) {
            return;
        }
        // no-cache rather than no-store: CloudFront may still collapse
        // simultaneous requests, it just may not serve a stale copy.
        put(PLAYLIST, content, "application/vnd.apple.mpegurl", "no-cache");
        lastPlaylist = content;
    }

    /**
     * The segments actually written, for when ffmpeg's playlist cannot be read.
     *
     * Names are zero-padded, so lexical order is chronological. The duration is
     * the configured segment length: ffmpeg's real figure is better and is used
     * whenever its playlist is available, but a playlist naming the right
     * segments with a nominal duration plays, and no playlist does not.
     */
    private List<PlaylistBuilder.Segment> segmentsOnDisk() throws IOException {
        if (!Files.isDirectory(directory)) {
            return List.of();
        }
        try (Stream<Path> entries = Files.list(directory)) {
            return entries
                    .filter(Files::isRegularFile)
                    .map(path -> path.getFileName().toString())
                    .filter(name -> name.endsWith(".m4s"))
                    .sorted()
                    .map(name -> new PlaylistBuilder.Segment(name, segmentSeconds, false))
                    .toList();
        }
    }

    /** The init segment on disk, named by ffmpeg's own convention. */
    private String initOnDisk() throws IOException {
        if (!Files.isDirectory(directory)) {
            return null;
        }
        try (Stream<Path> entries = Files.list(directory)) {
            return entries
                    .map(path -> path.getFileName().toString())
                    .filter(HlsPublisher::isInitSegment)
                    .findFirst()
                    .orElse(null);
        }
    }

    /** The configured segment length, for a playlist built without ffmpeg's. */
    public void segmentSeconds(double seconds) {
        if (seconds > 0) {
            this.segmentSeconds = seconds;
        }
    }

    /** Attaches the meter that watches how well the uplink is keeping up. */
    public void meter(ResourceMonitor monitor) {
        this.monitor = monitor;
    }

    private void put(String name, byte[] content, String contentType, String cacheControl) {
        long started = System.nanoTime();
        try {
            s3.putObject(
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(keyPrefix + name)
                            .contentType(contentType)
                            .cacheControl(cacheControl)
                            .build(),
                    RequestBody.fromBytes(content));
        } catch (RuntimeException e) {
            if (monitor != null) {
                monitor.recordUploadFailure();
            }
            throw e;
        }
        if (monitor != null) {
            monitor.recordUpload(content.length, (System.nanoTime() - started) / 1_000_000);
        }
    }
}
