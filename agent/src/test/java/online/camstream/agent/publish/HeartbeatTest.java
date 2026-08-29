package online.camstream.agent.publish;

import online.camstream.agent.health.Resources;
import online.camstream.agent.supervise.Supervisor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The heartbeat's whole justification is that it is cheap, so most of what
 * matters here is when it stays quiet.
 */
class HeartbeatTest {

    private final List<String> sent = new ArrayList<>();
    private final AtomicInteger publishing = new AtomicInteger();

    /** What the machine is reported to have left; healthy unless a test says otherwise. */
    private final AtomicReference<Resources.Verdict> verdict = new AtomicReference<>(
            new Resources.Verdict(Resources.Constraint.NONE, "", 2));
    private final AtomicReference<Resources.Snapshot> signs = new AtomicReference<>(
            Resources.Snapshot.unknown());
    private List<Supervisor.TaskHealth> health = List.of();
    private Instant now = Instant.parse("2026-08-27T10:00:00Z");

    private Heartbeat heartbeat() {
        return new Heartbeat(
                (suffix, payload) -> {
                    assertEquals("heartbeat", suffix);
                    sent.add(payload);
                },
                new Heartbeat.Vitals() {
                    @Override public int publishing() { return publishing.get(); }
                    @Override public int camerasConfigured() { return 3; }
                    @Override public List<Supervisor.TaskHealth> taskHealth() { return health; }
                    @Override public Resources.Verdict resources() { return verdict.get(); }
                    @Override public Resources.Snapshot vitalSigns() { return signs.get(); }
                },
                "1.2.3",
                Duration.ofMinutes(1),
                Duration.ofMinutes(15),
                () -> now);
    }

    private void advance(Duration by) {
        now = now.plus(by);
    }

    @Test
    void staysQuietBetweenIntervals() {
        Heartbeat heartbeat = heartbeat();
        heartbeat.tick();
        assertEquals(1, sent.size(), "the first tick establishes the baseline");

        advance(Duration.ofMinutes(5));
        heartbeat.tick();
        assertEquals(1, sent.size(), "idle agents wait out the long interval");

        advance(Duration.ofMinutes(11));
        heartbeat.tick();
        assertEquals(2, sent.size());
    }

    @Test
    void speedsUpWhileSomethingIsActuallyBeingWatched() {
        Heartbeat heartbeat = heartbeat();
        publishing.set(2);
        heartbeat.tick();
        assertEquals(1, sent.size());

        advance(Duration.ofMinutes(2));
        heartbeat.tick();
        // A stall now is costing a viewer their stream, so the slow cadence
        // would be the wrong trade.
        assertEquals(2, sent.size());
    }

    @Test
    void reportsImmediatelyWhenDemandChanges() {
        Heartbeat heartbeat = heartbeat();
        heartbeat.tick();
        assertEquals(1, sent.size());

        advance(Duration.ofSeconds(20));
        publishing.set(1);
        heartbeat.tick();
        assertEquals(2, sent.size(), "a stream starting is the interesting moment, not the next interval");
        assertTrue(sent.get(1).contains("\"publishing\":1"));
    }

    @Test
    void namesTheTasksThatAreFailing() {
        health = List.of(
                new Supervisor.TaskHealth("publish", true, 0, now),
                new Supervisor.TaskHealth("discovery", false, 4, now));
        Heartbeat heartbeat = heartbeat();
        heartbeat.tick();

        String payload = sent.get(0);
        assertTrue(payload.contains("\"healthy\":false"), payload);
        assertTrue(payload.contains("\"failingTasks\":\"discovery\""), payload);
    }

    @Test
    void sendsNothingExtraWhenEverythingIsWell() {
        health = List.of(new Supervisor.TaskHealth("publish", true, 0, now));
        Heartbeat heartbeat = heartbeat();
        heartbeat.tick();

        String payload = sent.get(0);
        assertTrue(payload.contains("\"healthy\":true"), payload);
        assertFalse(payload.contains("failingTasks"), "the healthy path is the one that repeats forever");
        assertTrue(payload.contains("\"agentVersion\":\"1.2.3\""));
        assertTrue(payload.contains("\"camerasConfigured\":3"));
    }

    @Test
    void retriesAfterAFailedPublishRatherThanCountingItAsSent() {
        Heartbeat heartbeat = new Heartbeat(
                (suffix, payload) -> { throw new IllegalStateException("not connected yet"); },
                new Heartbeat.Vitals() {
                    @Override public int publishing() { return 0; }
                    @Override public int camerasConfigured() { return 0; }
                    @Override public List<Supervisor.TaskHealth> taskHealth() { return List.of(); }
                    @Override public Resources.Verdict resources() {
                        return new Resources.Verdict(Resources.Constraint.NONE, "", 1);
                    }
                    @Override public Resources.Snapshot vitalSigns() {
                        return Resources.Snapshot.unknown();
                    }
                },
                "1.2.3", Duration.ofMinutes(1), Duration.ofMinutes(15), () -> now);

        // Fails during the connect handshake, when the listener does not yet
        // exist; the next tick must try again rather than wait a quarter hour.
        heartbeat.tick();
        advance(Duration.ofSeconds(20));
        assertDoesNotThrow(heartbeat::tick);
    }

    @Test
    @DisplayName("carries what the machine has left, and why it matters")
    void reportsTheBindingResource() {
        // The requirement this exists for: concurrent limits follow the
        // hardware, and the operator is told which piece of hardware.
        verdict.set(new Resources.Verdict(Resources.Constraint.CPU,
                "The processor is 95% busy.", 1));
        signs.set(new Resources.Snapshot(0.95, 0.4, 2L << 30, 40L << 30, 8_000_000, 400, 0));

        heartbeat().sendNow();

        String payload = sent.get(0);
        assertTrue(payload.contains("\"constraint\":\"cpu\""), payload);
        assertTrue(payload.contains("The processor is 95% busy."), payload);
        assertTrue(payload.contains("\"maxConcurrentTranscodes\":1"), payload);
        assertTrue(payload.contains("\"cpuLoad\":0.95"), payload);
        // A machine that cannot carry what it has been asked to is not healthy,
        // even with every task running.
        assertTrue(payload.contains("\"healthy\":false"), payload);
    }

    @Test
    @DisplayName("omits a reading the platform would not give")
    void unknownReadingsAreAbsentRatherThanMinusOne() {
        // A -1 in the record would be rendered downstream as a real
        // measurement — a processor at minus one hundred percent.
        signs.set(Resources.Snapshot.unknown());

        heartbeat().sendNow();

        String payload = sent.get(0);
        assertFalse(payload.contains("cpuLoad"), payload);
        assertFalse(payload.contains("diskFreeBytes"), payload);
        assertTrue(payload.contains("\"constraint\":\"none\""), payload);
    }
}
