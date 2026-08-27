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

    public record Rung(StreamProfile profile, String path, int width, int height, int bandwidthBps,
                       String codec, String codecProfile, Integer codecLevel) {}

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
            String codecs = rfc6381(rung.codec(), rung.codecProfile(), rung.codecLevel());
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
        // Rungs differing by codec are alternatives for different clients, not
        // a bitrate ladder — a player picks by what it can decode. Only rungs
        // sharing a codec need to be told apart by bandwidth.
        long distinctCodecs = rungs.stream().map(Rung::codec).distinct().count();
        if (distinctCodecs > 1) {
            return rungs;
        }
        long distinct = rungs.stream().map(Rung::bandwidthBps).distinct().count();
        if (distinct == rungs.size()) {
            return rungs;
        }
        log.info("camera reported indistinguishable bitrates for {} renditions; "
                + "estimating from resolution instead", rungs.size());
        List<Rung> estimated = new ArrayList<>(rungs.size());
        for (Rung rung : rungs) {
            estimated.add(new Rung(rung.profile(), rung.path(), rung.width(), rung.height(),
                    estimateBandwidth(rung.width(), rung.height(), null),
                    rung.codec(), rung.codecProfile(), rung.codecLevel()));
        }
        return estimated;
    }

    /**
     * The RFC 6381 codec string for a rung, derived from what the stream
     * actually carries.
     *
     * This used to answer "avc1.42E01E" for anything H.264, on the reasoning
     * that understating the profile is safe. It is not. A browser reads CODECS
     * to decide whether to even attempt a rung, and every browser refuses
     * H.264 High 10 — a 10-bit profile some cameras emit by default. Described
     * as Baseline, that stream is accepted, fetched, and then silently fails to
     * decode, which looks to a viewer exactly like a broken camera. Described
     * honestly, the player rejects it up front and CamStream can offer the
     * transcode that actually fixes it.
     */
    static String rfc6381(String codec, String profile, Integer level) {
        if (codec == null) {
            return null;
        }
        return switch (codec.toLowerCase()) {
            case "h264", "avc", "avc1" -> avc1(profile, level);
            case "hevc", "h265" -> hvc1(profile, level);
            default -> null;
        };
    }

    /**
     * avc1.PPCCLL — profile_idc, constraint flags, level_idc, each two hex
     * digits. The constraint byte is part of the profile's identity here:
     * Constrained Baseline and Main both set flags that a decoder matches on.
     */
    private static String avc1(String profile, Integer level) {
        String name = profile == null ? "" : profile.toLowerCase();
        String profileAndConstraints = switch (name) {
            case "baseline", "constrained baseline" -> "42E0";
            case "main" -> "4D40";
            case "extended" -> "5800";
            case "high" -> "6400";
            case "high 10", "high 10 intra" -> "6E00";
            case "high 4:2:2", "high 4:2:2 intra" -> "7A00";
            case "high 4:4:4 predictive", "high 4:4:4 intra" -> "F400";
            // An unrecognised profile is not a licence to guess: without a
            // CODECS attribute the player probes the stream itself, which is
            // slower but cannot be wrong.
            default -> null;
        };
        if (profileAndConstraints == null) {
            return null;
        }
        // ffprobe reports level scaled by ten, so 40 means level 4.0 and
        // level_idc is that same number, written in hex.
        int levelIdc = level == null || level <= 0 ? 30 : level;
        return "avc1." + profileAndConstraints + String.format("%02X", Math.min(levelIdc, 255));
    }

    /**
     * hvc1.P.C.LTT.B — profile, compatibility flags, tier and level, then
     * constraint bytes. Only the Main family is described; anything else gets
     * no CODECS attribute rather than a wrong one.
     */
    private static String hvc1(String profile, Integer level) {
        String name = profile == null ? "main" : profile.toLowerCase();
        int profileIdc = switch (name) {
            case "main" -> 1;
            case "main 10" -> 2;
            case "main still picture" -> 3;
            default -> 0;
        };
        if (profileIdc == 0) {
            return null;
        }
        // HEVC level_idc is the level times thirty: 93 is level 3.1, 120 is 4.0.
        int levelIdc = level == null || level <= 0 ? 93 : level;
        return "hvc1." + profileIdc + ".6.L" + levelIdc + ".B0";
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
