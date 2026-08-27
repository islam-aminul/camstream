package online.camstream.agent.publish;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.sync.RequestBody;
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

    private final S3Client s3;
    private final String bucket;
    private final String keyPrefix;
    private final Path directory;
    private final String label;

    private byte[] lastPlaylist;
    private final PlaylistBuilder playlist;

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
                        return (name.endsWith(".mp4") || name.endsWith(".m4s")) && !uploaded.contains(name);
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
            uploaded.add(name);
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
        if (!Files.isRegularFile(source)) {
            return;
        }
        String reported = Files.readString(source);
        if (reported.isBlank()) {
            return;
        }

        String init = PlaylistBuilder.parseInit(reported);
        if (init != null) {
            playlist.setInitSegment(init);
        }
        playlist.observe(PlaylistBuilder.parse(reported));
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

    private void put(String name, byte[] content, String contentType, String cacheControl) {
        s3.putObject(
                PutObjectRequest.builder()
                        .bucket(bucket)
                        .key(keyPrefix + name)
                        .contentType(contentType)
                        .cacheControl(cacheControl)
                        .build(),
                RequestBody.fromBytes(content));
    }
}
