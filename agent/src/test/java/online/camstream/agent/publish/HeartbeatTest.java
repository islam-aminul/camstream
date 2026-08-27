package online.camstream.agent.publish;

import online.camstream.agent.supervise.Supervisor;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The heartbeat's whole justification is that it is cheap, so most of what
 * matters here is when it stays quiet.
 */
class HeartbeatTest {

    private final List<String> sent = new ArrayList<>();
    private final AtomicInteger publishing = new AtomicInteger();
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
                },
                "1.2.3", Duration.ofMinutes(1), Duration.ofMinutes(15), () -> now);

        // Fails during the connect handshake, when the listener does not yet
        // exist; the next tick must try again rather than wait a quarter hour.
        heartbeat.tick();
        advance(Duration.ofSeconds(20));
        assertDoesNotThrow(heartbeat::tick);
    }
}
