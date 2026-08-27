package online.camstream.agent.publish;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Builds the live playlist rather than relaying ffmpeg's.
 *
 * ffmpeg writes a playlist per process, so every restart — a camera blink, a
 * network drop — resets EXT-X-MEDIA-SEQUENCE to zero and appends EXT-X-ENDLIST.
 * A player reading that concludes the stream ended and, if it reconnects, sees
 * sequence numbers it has already consumed. Relaying it meant stripping the
 * ENDLIST back out and hoping.
 *
 * Owning the playlist instead gives a sequence that only ever increases, an
 * EXT-X-DISCONTINUITY where the encoder actually restarted, and a target
 * duration measured from the segments rather than declared in advance.
 *
 * It also carries EXT-X-PROGRAM-DATE-TIME, which is what lets a viewer see how
 * far behind live they are: without a wall clock in the playlist the player
 * knows its position in the stream but not what that position corresponds to
 * in real time, and end-to-end delay cannot be measured at all.
 */
final class PlaylistBuilder {

    /** One published segment, as ffmpeg reported it. */
    record Segment(String filename, double durationSeconds, boolean discontinuity) {}

    /** A segment once it has been placed on the wall clock. */
    private record Timed(Segment segment, Instant startsAt) {}

    private static final DateTimeFormatter PDT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSXXX").withZone(ZoneOffset.UTC);

    private final int windowSize;
    private final Clock clock;
    private final Deque<Timed> window = new ArrayDeque<>();
    private final Set<String> everSeen = new LinkedHashSet<>();

    private long mediaSequence;
    private String initSegment;
    private boolean discontinuityPending;
    /** Where the next segment starts, carried forward across window eviction. */
    private Instant nextStart;

    PlaylistBuilder(int windowSize) {
        this(windowSize, Clock.systemUTC());
    }

    PlaylistBuilder(int windowSize, Clock clock) {
        this.windowSize = Math.max(3, windowSize);
        this.clock = clock;
    }

    /**
     * Marks that the encoder restarted. The next segment carries a
     * discontinuity, telling the player its timeline and codec parameters may
     * jump rather than leaving it to discover that by failing.
     */
    void encoderRestarted() {
        discontinuityPending = true;
    }

    void setInitSegment(String filename) {
        this.initSegment = filename;
    }

    /**
     * Absorbs the segments ffmpeg currently lists.
     *
     * ffmpeg is the authority on duration — it knows the real timestamps —
     * but not on numbering, which is per-process. Segments already seen are
     * ignored, so a restart cannot rewind the sequence.
     */
    void observe(List<Segment> reported) {
        for (Segment segment : reported) {
            if (!everSeen.add(segment.filename())) {
                continue;
            }
            boolean discontinuity = discontinuityPending;
            discontinuityPending = false;

            // ffmpeg closes a segment once it is complete, so a segment first
            // seen now ended at roughly now. Only the first segment of a
            // continuous run is anchored that way; the rest follow from their
            // predecessors' durations, which keeps the timeline smooth rather
            // than jittering by however long the last sweep took.
            long millis = Math.round(segment.durationSeconds() * 1000);
            Instant startsAt = (discontinuity || nextStart == null)
                    ? clock.instant().minusMillis(millis)
                    : nextStart;
            nextStart = startsAt.plusMillis(millis);

            window.addLast(new Timed(
                    new Segment(segment.filename(), segment.durationSeconds(), discontinuity), startsAt));
            while (window.size() > windowSize) {
                window.removeFirst();
                // The sequence names the first segment still listed, so it
                // advances only as segments fall out of the window.
                mediaSequence++;
            }
        }
    }

    boolean isEmpty() {
        return window.isEmpty();
    }

    /** The media playlist, as it should appear to a viewer right now. */
    String render() {
        // EXT-X-TARGETDURATION must be an integer and must not be less than any
        // segment; a player treats an understated value as a broken stream.
        int target = 1;
        for (Timed entry : window) {
            target = Math.max(target, (int) Math.ceil(entry.segment().durationSeconds() - 0.001));
        }

        StringBuilder playlist = new StringBuilder(256);
        playlist.append("#EXTM3U\n")
                .append("#EXT-X-VERSION:7\n")
                .append("#EXT-X-TARGETDURATION:").append(target).append('\n')
                .append("#EXT-X-MEDIA-SEQUENCE:").append(mediaSequence).append('\n')
                .append("#EXT-X-INDEPENDENT-SEGMENTS\n");

        if (initSegment != null) {
            playlist.append("#EXT-X-MAP:URI=\"").append(initSegment).append("\"\n");
        }
        boolean datePending = true;
        for (Timed entry : window) {
            Segment segment = entry.segment();
            if (segment.discontinuity()) {
                playlist.append("#EXT-X-DISCONTINUITY\n");
                // A discontinuity breaks the derivation, so the clock has to be
                // restated on the far side of it.
                datePending = true;
            }
            if (datePending) {
                playlist.append("#EXT-X-PROGRAM-DATE-TIME:")
                        .append(PDT.format(entry.startsAt())).append('\n');
                datePending = false;
            }
            playlist.append("#EXTINF:").append(String.format("%.3f", segment.durationSeconds())).append(",\n")
                    .append(segment.filename()).append('\n');
        }
        // Deliberately no EXT-X-ENDLIST: this stream has not ended, and saying
        // it has is what made a player give up after a transient encoder fault.
        return playlist.toString();
    }

    /**
     * Reads ffmpeg's own playlist for the facts it owns — which segments exist
     * and how long each is.
     */
    static List<Segment> parse(String ffmpegPlaylist) {
        List<Segment> segments = new ArrayList<>();
        double pendingDuration = 0;
        for (String line : ffmpegPlaylist.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("#EXTINF:")) {
                String value = trimmed.substring("#EXTINF:".length()).split(",")[0].trim();
                try {
                    pendingDuration = Double.parseDouble(value);
                } catch (NumberFormatException e) {
                    pendingDuration = 0;
                }
            } else if (!trimmed.isEmpty() && !trimmed.startsWith("#")) {
                segments.add(new Segment(trimmed, pendingDuration, false));
                pendingDuration = 0;
            }
        }
        return segments;
    }

    /** The init segment ffmpeg declared, if any. */
    static String parseInit(String ffmpegPlaylist) {
        for (String line : ffmpegPlaylist.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("#EXT-X-MAP:")) {
                int start = trimmed.indexOf("URI=\"");
                if (start >= 0) {
                    int end = trimmed.indexOf('"', start + 5);
                    if (end > start) {
                        return trimmed.substring(start + 5, end);
                    }
                }
            }
        }
        return null;
    }
}
