package online.camstream.agent.publish;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Building a playlist without ffmpeg's.
 *
 * The failure this exists for: segments uploaded for twenty minutes and no
 * playlist ever named them. The stream was in the bucket, complete and
 * unreachable, and nothing reported a fault because the publisher returned
 * quietly whenever ffmpeg's own playlist could not be read.
 *
 * ffmpeg owns the exact durations and is still preferred. What changed is that
 * its absence is no longer a reason to publish nothing.
 */
class PlaylistFallbackTest {

    @Test
    @DisplayName("a playlist built from segment names alone is still a playlist")
    void buildsFromSegmentsAlone() {
        PlaylistBuilder playlist = new PlaylistBuilder(4);
        playlist.setInitSegment("run_init.mp4");
        playlist.observe(List.of(
                new PlaylistBuilder.Segment("run_000000.m4s", 4.0, false),
                new PlaylistBuilder.Segment("run_000001.m4s", 4.0, false)));

        assertFalse(playlist.isEmpty());
        String rendered = playlist.render();
        assertTrue(rendered.contains("#EXTM3U"), rendered);
        assertTrue(rendered.contains("run_init.mp4"), rendered);
        assertTrue(rendered.contains("run_000000.m4s"), rendered);
        assertTrue(rendered.contains("run_000001.m4s"), rendered);
    }

    @Test
    @DisplayName("ffmpeg's durations are used when its playlist can be read")
    void prefersFfmpegDurations() {
        // Zero-padded names sort chronologically, which is what makes a
        // directory listing a usable substitute in the first place.
        List<PlaylistBuilder.Segment> parsed = PlaylistBuilder.parse(String.join("\n",
                "#EXTM3U",
                "#EXT-X-MAP:URI=\"run_init.mp4\"",
                "#EXTINF:3.968000,",
                "#EXT-X-PROGRAM-DATE-TIME:2026-08-29T18:08:05.953+05:30",
                "run_000000.m4s"));

        assertEquals(1, parsed.size());
        assertEquals("run_000000.m4s", parsed.get(0).filename());
        assertEquals(3.968, parsed.get(0).durationSeconds(), 0.0001);
    }

    @Test
    @DisplayName("a date-time line between the duration and the name does not lose either")
    void programDateTimeDoesNotBreakPairing() {
        // ffmpeg emits EXTINF, then PROGRAM-DATE-TIME, then the file. A parser
        // that expected them adjacent would silently produce nothing.
        List<PlaylistBuilder.Segment> parsed = PlaylistBuilder.parse(String.join("\n",
                "#EXTINF:4.000000,",
                "#EXT-X-PROGRAM-DATE-TIME:2026-08-29T18:08:05.953+05:30",
                "a.m4s",
                "#EXTINF:4.000000,",
                "#EXT-X-PROGRAM-DATE-TIME:2026-08-29T18:08:09.953+05:30",
                "b.m4s"));

        assertEquals(List.of("a.m4s", "b.m4s"),
                parsed.stream().map(PlaylistBuilder.Segment::filename).toList());
    }

    @Test
    @DisplayName("an empty or absent ffmpeg playlist yields nothing to observe")
    void emptyPlaylistParsesToNothing() {
        assertTrue(PlaylistBuilder.parse("").isEmpty());
        assertTrue(PlaylistBuilder.parse("#EXTM3U\n#EXT-X-VERSION:7\n").isEmpty());
    }
}
