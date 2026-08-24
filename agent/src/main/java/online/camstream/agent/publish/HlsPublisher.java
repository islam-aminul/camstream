package online.camstream.agent.publish;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.io.IOException;
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

    /** Hashed by name: ffmpeg never rewrites a segment once it is closed. */
    private final Set<String> uploaded = new HashSet<>();

    private final S3Client s3;
    private final String bucket;
    private final String keyPrefix;
    private final Path directory;
    private final String label;

    private byte[] lastPlaylist;

    public HlsPublisher(S3Client s3, String bucket, String keyPrefix, Path directory, String label) {
        this.s3 = s3;
        this.bucket = bucket;
        this.keyPrefix = keyPrefix.endsWith("/") ? keyPrefix : keyPrefix + "/";
        this.directory = directory;
        this.label = label;
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

    private void uploadPlaylistIfChanged() throws IOException {
        Path playlist = directory.resolve(PLAYLIST);
        if (!Files.isRegularFile(playlist)) {
            return;
        }
        byte[] content = stripEndList(Files.readAllBytes(playlist));
        if (content.length == 0 || Arrays.equals(content, lastPlaylist)) {
            return;
        }
        // no-cache rather than no-store: CloudFront may still collapse
        // simultaneous requests, it just may not serve a stale copy.
        put(PLAYLIST, content, "application/vnd.apple.mpegurl", "no-cache");
        lastPlaylist = content;
    }

    /**
     * Removes EXT-X-ENDLIST.
     *
     * ffmpeg writes it whenever it exits, including on a camera hiccup that the
     * agent immediately recovers from. A player that sees it stops for good, so
     * for a continuously-restarted live feed the tag is never what we mean.
     */
    static byte[] stripEndList(byte[] playlist) {
        String text = new String(playlist, java.nio.charset.StandardCharsets.UTF_8);
        if (!text.contains("#EXT-X-ENDLIST")) {
            return playlist;
        }
        String cleaned = text.lines()
                .filter(line -> !line.strip().equals("#EXT-X-ENDLIST"))
                .collect(java.util.stream.Collectors.joining("\n", "", "\n"));
        return cleaned.getBytes(java.nio.charset.StandardCharsets.UTF_8);
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
