package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Walking a recorder's channels, tested without a recorder.
 *
 * The arithmetic is the part that goes subtly wrong: stop too eagerly and a
 * sixteen-channel recorder with one empty bay reports four cameras; stop too
 * late and every four-channel recorder costs sixty timeouts.
 */
class ChannelWalkTest {

    /** Runs a walk against a recorder whose live channels are known. */
    private static List<Integer> walk(Set<Integer> live, int maxChannels, int stopAfterEmpty) {
        ChannelWalk walk = new ChannelWalk(maxChannels, stopAfterEmpty);
        List<Integer> found = new ArrayList<>();
        while (walk.hasNext()) {
            int channel = walk.next();
            if (live.contains(channel)) {
                walk.found();
                found.add(channel);
            } else {
                walk.empty();
            }
        }
        return found;
    }

    @Test
    @DisplayName("finds every channel on a full recorder")
    void findsAFullRecorder() {
        assertEquals(List.of(1, 2, 3, 4), walk(Set.of(1, 2, 3, 4), 64, 3));
    }

    @Test
    @DisplayName("walks past gaps, because an empty bay is not the end")
    void walksPastGaps() {
        // A sixteen-channel recorder with cameras on 1, 2, 5 and 6. Stopping at
        // the first silence would report two of the four.
        assertEquals(List.of(1, 2, 5, 6), walk(Set.of(1, 2, 5, 6), 64, 3));
    }

    @Test
    @DisplayName("gives up on a run of empty channels rather than walking to the ceiling")
    void stopsAfterARunOfSilence() {
        ChannelWalk walk = new ChannelWalk(64, 3);
        while (walk.hasNext()) {
            walk.next();
            walk.empty();
        }
        // Three probes, not sixty-four.
        assertEquals(3, walk.lastChannel());
        assertEquals(0, walk.channelsFound());
    }

    @Test
    @DisplayName("a gap wider than the tolerance ends the walk")
    void aWideGapEndsIt() {
        // Cameras on 1 and 9. Four empty channels in a row is a recorder that
        // has finished, not one with a bay free.
        assertEquals(List.of(1), walk(Set.of(1, 9), 64, 3));
    }

    @Test
    @DisplayName("stops at the ceiling on a recorder that never runs out")
    void respectsTheCeiling() {
        ChannelWalk walk = new ChannelWalk(8, 3);
        int probes = 0;
        while (walk.hasNext()) {
            walk.next();
            walk.found();
            probes++;
        }
        assertEquals(8, probes);
    }

    @Test
    @DisplayName("counts from one, because that is how recorders are labelled")
    void countsFromOne() {
        ChannelWalk walk = new ChannelWalk(4, 3);
        assertTrue(walk.hasNext());
        assertEquals(1, walk.next());
        assertEquals(2, walk.next());
    }

    @Test
    @DisplayName("the shipped defaults are the ones the walk was reasoned about with")
    void defaultsAreWhatTheyClaim() {
        assertEquals(64, ChannelWalk.MAX_CHANNELS);
        assertEquals(3, ChannelWalk.STOP_AFTER_EMPTY);
    }
}
