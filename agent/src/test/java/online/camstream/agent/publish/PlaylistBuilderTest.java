package online.camstream.agent.publish;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class PlaylistBuilderTest {

    private static final String FFMPEG_PLAYLIST = """
        #EXTM3U
        #EXT-X-VERSION:7
        #EXT-X-TARGETDURATION:4
        #EXT-X-MEDIA-SEQUENCE:0
        #EXT-X-MAP:URI="run1_init.mp4"
        #EXTINF:3.200000,
        run1_000000.m4s
        #EXTINF:3.200000,
        run1_000001.m4s
        #EXT-X-ENDLIST
        """;

    @Test
    void readsDurationsAndInitFromFfmpeg() {
        List<PlaylistBuilder.Segment> segments = PlaylistBuilder.parse(FFMPEG_PLAYLIST);
        assertEquals(2, segments.size());
        assertEquals("run1_000000.m4s", segments.get(0).filename());
        assertEquals(3.2, segments.get(0).durationSeconds(), 0.001);
        assertEquals("run1_init.mp4", PlaylistBuilder.parseInit(FFMPEG_PLAYLIST));
    }

    @Test
    void neverEndsTheStream() {
        PlaylistBuilder builder = new PlaylistBuilder(4);
        builder.observe(PlaylistBuilder.parse(FFMPEG_PLAYLIST));
        // ffmpeg appends ENDLIST whenever it exits, including for a hiccup the
        // agent recovers from in a second. A player that sees it stops for good.
        assertFalse(builder.render().contains("#EXT-X-ENDLIST"));
    }

    @Test
    void targetDurationCoversTheLongestSegment() {
        PlaylistBuilder builder = new PlaylistBuilder(4);
        builder.observe(List.of(
                new PlaylistBuilder.Segment("a.m4s", 3.2, false),
                new PlaylistBuilder.Segment("b.m4s", 4.9, false)));
        // Understating this is treated by players as a broken stream.
        assertTrue(builder.render().contains("#EXT-X-TARGETDURATION:5"));
    }

    @Test
    void sequenceAdvancesOnlyAsSegmentsLeaveTheWindow() {
        PlaylistBuilder builder = new PlaylistBuilder(3);
        for (int i = 0; i < 3; i++) {
            builder.observe(List.of(new PlaylistBuilder.Segment("s" + i + ".m4s", 2.0, false)));
        }
        assertTrue(builder.render().contains("#EXT-X-MEDIA-SEQUENCE:0"));

        builder.observe(List.of(new PlaylistBuilder.Segment("s3.m4s", 2.0, false)));
        assertTrue(builder.render().contains("#EXT-X-MEDIA-SEQUENCE:1"));
        assertFalse(builder.render().contains("s0.m4s"), "the oldest segment should have fallen out");
    }

    @Test
    void aRestartDoesNotRewindTheSequence() {
        PlaylistBuilder builder = new PlaylistBuilder(3);
        for (int i = 0; i < 5; i++) {
            builder.observe(List.of(new PlaylistBuilder.Segment("run1_" + i + ".m4s", 2.0, false)));
        }
        String before = builder.render();
        assertTrue(before.contains("#EXT-X-MEDIA-SEQUENCE:2"));

        // ffmpeg restarts and numbers its own segments from zero again.
        builder.encoderRestarted();
        builder.observe(List.of(new PlaylistBuilder.Segment("run2_0.m4s", 2.0, false)));

        String after = builder.render();
        assertTrue(after.contains("#EXT-X-MEDIA-SEQUENCE:3"),
                "sequence must keep increasing across an encoder restart");
        assertTrue(after.contains("#EXT-X-DISCONTINUITY"),
                "the player must be told the timeline jumped");
    }

    @Test
    void onlyTheFirstSegmentAfterARestartIsDiscontinuous() {
        PlaylistBuilder builder = new PlaylistBuilder(4);
        builder.encoderRestarted();
        builder.observe(List.of(
                new PlaylistBuilder.Segment("a.m4s", 2.0, false),
                new PlaylistBuilder.Segment("b.m4s", 2.0, false)));
        assertEquals(1, builder.render().split("#EXT-X-DISCONTINUITY", -1).length - 1);
    }

    @Test
    void ignoresSegmentsItHasAlreadyPublished() {
        PlaylistBuilder builder = new PlaylistBuilder(4);
        // ffmpeg's playlist repeats its whole window on every poll.
        builder.observe(PlaylistBuilder.parse(FFMPEG_PLAYLIST));
        builder.observe(PlaylistBuilder.parse(FFMPEG_PLAYLIST));
        assertEquals(2, builder.render().split("#EXTINF", -1).length - 1);
    }

    @Test
    void datesTheStreamSoAViewerCanSeeHowFarBehindLiveTheyAre() {
        // Fixed clock: the assertion is about which instant is derived, not
        // about how long the test took to run.
        java.time.Instant now = java.time.Instant.parse("2026-08-27T10:00:06Z");
        PlaylistBuilder builder = new PlaylistBuilder(
                3, java.time.Clock.fixed(now, java.time.ZoneOffset.UTC));

        builder.observe(List.of(new PlaylistBuilder.Segment("a.m4s", 2.0, false)));
        // The first segment ended about now, so it started two seconds ago.
        assertTrue(builder.render().contains("#EXT-X-PROGRAM-DATE-TIME:2026-08-27T10:00:04.000Z"),
                builder.render());

        // The second follows from the first's duration rather than being
        // re-anchored, so a slow sweep cannot make the timeline jitter.
        builder.observe(List.of(new PlaylistBuilder.Segment("b.m4s", 2.0, false)));
        String playlist = builder.render();
        assertEquals(1, playlist.lines().filter(l -> l.startsWith("#EXT-X-PROGRAM-DATE-TIME")).count(),
                "one date anchors the run; the rest derive from it");
    }

    @Test
    void restatesTheClockAfterADiscontinuity() {
        PlaylistBuilder builder = new PlaylistBuilder(5);
        builder.observe(List.of(new PlaylistBuilder.Segment("a.m4s", 2.0, false)));
        builder.encoderRestarted();
        builder.observe(List.of(new PlaylistBuilder.Segment("b.m4s", 2.0, false)));

        String playlist = builder.render();
        assertEquals(2, playlist.lines().filter(l -> l.startsWith("#EXT-X-PROGRAM-DATE-TIME")).count(),
                "a restart breaks the derivation, so the clock has to be restated");
        assertTrue(playlist.indexOf("#EXT-X-DISCONTINUITY")
                < playlist.indexOf("#EXT-X-PROGRAM-DATE-TIME:", playlist.indexOf("a.m4s")),
                "the new date belongs after the discontinuity it follows");
    }
}
