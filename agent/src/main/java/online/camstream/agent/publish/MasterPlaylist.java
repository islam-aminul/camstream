package online.camstream.agent.publish;

import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.control.Rendition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * A master playlist offering the camera's own renditions as an ABR ladder.
 *
 * The rungs are what the camera already produces — its sub and main profiles —
 * so adaptation costs nothing extra to generate. This only appears while both
 * are actually being published, which in practice means the detail view: that
 * is where a 1080p stream can outrun a viewer's connection and a rung to drop
 * to is worth having. Advertising a rendition that is not being published would
 * make the player switch up into a 404.
 */
public final class MasterPlaylist {

    private static final Logger log = LoggerFactory.getLogger(MasterPlaylist.class);

    public record Rung(StreamProfile profile, String path, int width, int height, int bandwidthBps, String codec) {}

    private MasterPlaylist() {
    }

    /**
     * Writes {@code master.m3u8} beside the rendition directories, or removes
     * the need for one by returning false when fewer than two rungs exist.
     */
    public static boolean publish(S3Client s3, String bucket, String cameraPrefix, List<Rung> rungs) {
        List<Rung> usable = rungs.stream()
                .filter(Objects::nonNull)
                .filter(rung -> rung.width() > 0 && rung.height() > 0)
                .toList();
        if (usable.size() < 2) {
            return false;
        }

        usable = discriminate(usable).stream()
                // Lowest first: hls.js starts on the first variant, and starting
                // small then climbing beats stalling on the way down.
                .sorted(Comparator.comparingInt(Rung::bandwidthBps))
                .toList();

        StringBuilder playlist = new StringBuilder("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        for (Rung rung : usable) {
            playlist.append("#EXT-X-STREAM-INF:BANDWIDTH=").append(rung.bandwidthBps())
                    .append(",RESOLUTION=").append(rung.width()).append('x').append(rung.height());
            String codecs = rfc6381(rung.codec());
            if (codecs != null) {
                playlist.append(",CODECS=\"").append(codecs).append('"');
            }
            playlist.append('\n').append(rung.path()).append('\n');
        }

        byte[] body = playlist.toString().getBytes(StandardCharsets.UTF_8);
        try {
            s3.putObject(
                    PutObjectRequest.builder()
                            .bucket(bucket)
                            .key(cameraPrefix + "master.m3u8")
                            .contentType("application/vnd.apple.mpegurl")
                            // Rungs appear and disappear as viewers come and go.
                            .cacheControl("no-cache")
                            .build(),
                    RequestBody.fromBytes(body));
            return true;
        } catch (RuntimeException e) {
            log.warn("could not publish master playlist for {}: {}", cameraPrefix, e.toString());
            return false;
        }
    }

    /**
     * Ensures the rungs are actually distinguishable.
     *
     * A real camera reported the same BitrateLimit — 2048 kbps — for both its
     * 1080p and its 640x360 profile, which is plainly untrue of the smaller
     * one. Equal BANDWIDTH values make a ladder useless: the player cannot tell
     * the rungs apart and may pick the largest on a poor connection. Where the
     * declared figures fail to discriminate, they are discarded in favour of
     * estimates derived from resolution, which at least order correctly.
     */
    static List<Rung> discriminate(List<Rung> rungs) {
        long distinct = rungs.stream().map(Rung::bandwidthBps).distinct().count();
        if (distinct == rungs.size()) {
            return rungs;
        }
        log.info("camera reported indistinguishable bitrates for {} renditions; "
                + "estimating from resolution instead", rungs.size());
        List<Rung> estimated = new ArrayList<>(rungs.size());
        for (Rung rung : rungs) {
            estimated.add(new Rung(rung.profile(), rung.path(), rung.width(), rung.height(),
                    estimateBandwidth(rung.width(), rung.height(), null), rung.codec()));
        }
        return estimated;
    }

    /**
     * CODECS is advisory but players use it to decide whether they can play a
     * rung before fetching it — a wrong value is worse than none, so only the
     * two codecs actually produced here are described, and conservatively.
     */
    static String rfc6381(String codec) {
        if (codec == null) {
            return null;
        }
        return switch (codec.toLowerCase()) {
            // Baseline 3.0: understates the profile deliberately. Claiming a
            // higher one than the camera emits would have players reject a
            // stream they could in fact decode.
            case "h264", "avc", "avc1" -> "avc1.42E01E";
            case "hevc", "h265" -> "hvc1.1.6.L93.B0";
            default -> null;
        };
    }

    /** Bandwidth hint from resolution when the camera reports no bitrate. */
    public static int estimateBandwidth(int width, int height, Integer declaredKbps) {
        if (declaredKbps != null && declaredKbps > 0) {
            // Peak, not average: BANDWIDTH is defined as the peak segment rate.
            return (int) (declaredKbps * 1000 * 1.2);
        }
        long pixels = (long) width * height;
        // Roughly 0.1 bits per pixel per frame at 15fps, which lands close to
        // typical CCTV encoder settings without pretending to be precise.
        return (int) Math.max(200_000, Math.min(pixels * 3, 8_000_000));
    }

    public static List<Rung> rungsFor(List<Rendition> active, java.util.function.Function<Rendition, Rung> describe) {
        List<Rung> rungs = new ArrayList<>();
        for (Rendition rendition : active) {
            Rung rung = describe.apply(rendition);
            if (rung != null) {
                rungs.add(rung);
            }
        }
        return rungs;
    }
}
