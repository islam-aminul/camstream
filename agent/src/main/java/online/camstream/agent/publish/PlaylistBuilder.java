package online.camstream.agent.publish;

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
 */
final class PlaylistBuilder {

    /** One published segment, as ffmpeg reported it. */
    record Segment(String filename, double durationSeconds, boolean discontinuity) {}

    private final int windowSize;
    private final Deque<Segment> window = new ArrayDeque<>();
    private final Set<String> everSeen = new LinkedHashSet<>();

    private long mediaSequence;
    private String initSegment;
    private boolean discontinuityPending;

    PlaylistBuilder(int windowSize) {
        this.windowSize = Math.max(3, windowSize);
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
            window.addLast(new Segment(segment.filename(), segment.durationSeconds(), discontinuity));
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
        for (Segment segment : window) {
            target = Math.max(target, (int) Math.ceil(segment.durationSeconds() - 0.001));
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
        for (Segment segment : window) {
            if (segment.discontinuity()) {
                playlist.append("#EXT-X-DISCONTINUITY\n");
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
