package online.camstream.agent.health;

import online.camstream.agent.health.Resources.Constraint;
import online.camstream.agent.health.Resources.Snapshot;
import online.camstream.agent.health.Resources.Verdict;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The judgement about what a machine can carry, tested without a machine.
 *
 * These messages are the product: the requirement was that concurrent limits
 * follow the hardware, and that the operator be told what to do about it. A
 * verdict that says "degraded" satisfies neither half.
 */
class ResourcesTest {

    private static final int SEGMENT_MILLIS = 4000;

    private static Snapshot healthy() {
        return new Snapshot(0.30, 0.50, 4L << 30, 40L << 30, 8_000_000, 400, 0);
    }

    private static Verdict assess(Snapshot snapshot) {
        return Resources.assess(snapshot, 4, 3, SEGMENT_MILLIS);
    }

    @Test
    @DisplayName("a machine with headroom is left alone at its configured cap")
    void healthyMachineKeepsItsCap() {
        Verdict verdict = assess(healthy());
        assertEquals(Constraint.NONE, verdict.constraint());
        assertEquals(4, verdict.maxConcurrentTranscodes());
        assertTrue(verdict.healthy());
        assertEquals("", verdict.message());
    }

    @Test
    @DisplayName("a busy processor sheds one conversion, not the whole wall")
    void cpuPressureShedsOneConversion() {
        // Conversions are the discretionary cost. A passed-through stream is a
        // copy; shedding those would take cameras off screen for nothing.
        Verdict verdict = assess(new Snapshot(0.95, 0.5, 4L << 30, 40L << 30, 8_000_000, 400, 0));

        assertEquals(Constraint.CPU, verdict.constraint());
        assertEquals(2, verdict.maxConcurrentTranscodes());
        assertTrue(verdict.message().contains("95%"), verdict.message());
        assertTrue(verdict.message().contains("full encode"), verdict.message());
    }

    @Test
    @DisplayName("memory pressure says how much is left, not just that it is low")
    void memoryPressureNamesTheNumber() {
        Verdict verdict = assess(new Snapshot(0.2, 0.94, 300L << 20, 40L << 30, 8_000_000, 400, 0));

        assertEquals(Constraint.MEMORY, verdict.constraint());
        assertTrue(verdict.message().contains("300 MB"), verdict.message());
        assertTrue(verdict.message().contains("94%"), verdict.message());
    }

    @Test
    @DisplayName("a high percentage with room to spare is not pressure")
    void aFullLookingLargeMachineIsFine() {
        // The case that cried wolf: a workstation at 95% with the better part
        // of a gigabyte free. A percentage says nothing about whether another
        // encode will fit; the bytes do.
        Verdict verdict = assess(new Snapshot(0.2, 0.95, 815L << 20, 40L << 30, 8_000_000, 400, 0));
        assertEquals(Constraint.NONE, verdict.constraint());
    }

    @Test
    @DisplayName("a low percentage on a tiny machine still is")
    void aSmallMachineWithNothingLeftIsPressure() {
        // The mirror of it: 80% used, but of very little.
        Verdict verdict = assess(new Snapshot(0.2, 0.80, 200L << 20, 40L << 30, 8_000_000, 400, 0));
        assertEquals(Constraint.MEMORY, verdict.constraint());
    }

    @Test
    @DisplayName("a full disk stops conversion entirely, because shedding cannot make room")
    void fullDiskStopsEverything() {
        Verdict verdict = assess(new Snapshot(0.2, 0.5, 4L << 30, 100L << 20, 8_000_000, 400, 0));

        assertEquals(Constraint.DISK, verdict.constraint());
        assertEquals(0, verdict.maxConcurrentTranscodes());
        assertTrue(verdict.message().contains("100 MB"), verdict.message());
    }

    @Test
    @DisplayName("an upload slower than the segment it sends can never catch up")
    void uplinkThatCannotKeepUp() {
        // The arithmetic that matters: if a four-second segment takes six
        // seconds to send, the next one is already waiting and the site drifts
        // further behind live every segment.
        Verdict verdict = assess(new Snapshot(0.2, 0.5, 4L << 30, 40L << 30, 500_000, 6200, 0));

        assertEquals(Constraint.UPLINK, verdict.constraint());
        assertTrue(verdict.message().contains("6.2s"), verdict.message());
        assertTrue(verdict.message().contains("4.0s"), verdict.message());
        assertTrue(verdict.message().contains("connection"), verdict.message());
    }

    @Test
    @DisplayName("an upload comfortably inside the segment is not a problem")
    void uplinkWithHeadroomIsFine() {
        Verdict verdict = assess(new Snapshot(0.2, 0.5, 4L << 30, 40L << 30, 8_000_000, 3900, 0));
        assertEquals(Constraint.NONE, verdict.constraint());
    }

    @Test
    @DisplayName("failed uploads are reported as gaps the viewer will see")
    void failedUploadsAreReported() {
        Verdict verdict = assess(new Snapshot(0.2, 0.5, 4L << 30, 40L << 30, 8_000_000, 400, 3));

        assertEquals(Constraint.UPLINK, verdict.constraint());
        assertTrue(verdict.message().contains("3 segment uploads failed"), verdict.message());
        assertTrue(verdict.message().contains("gaps"), verdict.message());
    }

    @Test
    @DisplayName("the disk is reported before anything else, since nothing else can fix it")
    void diskOutranksTheRest() {
        Verdict verdict = assess(new Snapshot(0.99, 0.99, 10L << 20, 10L << 20, 100, 9000, 5));
        assertEquals(Constraint.DISK, verdict.constraint());
    }

    @Test
    @DisplayName("a platform that will not report a figure is not treated as healthy")
    void unknownValuesAreNotHealthy() {
        // -1 means the platform declined to say. Comparing it against a ceiling
        // as though it were a real reading would report every machine as idle.
        Verdict verdict = Resources.assess(Snapshot.unknown(), 4, 3, SEGMENT_MILLIS);
        assertEquals(Constraint.NONE, verdict.constraint());
        assertEquals(4, verdict.maxConcurrentTranscodes());
    }

    @Test
    @DisplayName("shedding stops at zero rather than going negative")
    void shedddingHasAFloor() {
        Verdict verdict = Resources.assess(
                new Snapshot(0.99, 0.5, 4L << 30, 40L << 30, 8_000_000, 400, 0), 1, 0, SEGMENT_MILLIS);
        assertEquals(0, verdict.maxConcurrentTranscodes());
    }

    @Test
    @DisplayName("figures read the way a person would say them")
    void figuresAreReadable() {
        Verdict verdict = assess(new Snapshot(0.2, 0.94, 400L << 20, 40L << 30, 8_000_000, 400, 0));
        assertTrue(verdict.message().contains("400 MB"), verdict.message());
    }
}
