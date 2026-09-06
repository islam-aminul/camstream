package online.camstream.agent.publish;

import online.camstream.agent.health.Resources;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A heartbeat that cannot be sent says so in the log.
 *
 * This was {@code log.debug}, and the consequence showed up on 2026-09-06. The
 * "no agent has sent a heartbeat for forty-five minutes" alarm fired at 01:54
 * IST, and the agent's own log — at the level it actually ships at — had not
 * one word about heartbeats anywhere in it. The alarm was the only thing that
 * spoke, and it can only say that heartbeats stopped, never why.
 *
 * That is the wrong way round. The heartbeat is what the alarm watches, so a
 * heartbeat that fails is precisely the event worth a line: it is the agent's
 * own account of the thing the fleet is about to be paged for.
 *
 * Once per distinct fault, not once per tick. tick() runs every twenty seconds,
 * so an outage lasting a night would otherwise be some two and a half thousand
 * identical lines, which buries whatever caused it — the same reasoning, and
 * the same shape, as {@link UploadFailureNoiseTest}.
 */
class HeartbeatFailureNoiseTest {

    /** Fails on demand, so an outage can be started and ended. */
    private static final class FlakyPublisher implements Heartbeat.Publisher {
        volatile RuntimeException failure;
        int published;

        @Override
        public void publish(String suffix, String payload) {
            published++;
            if (failure != null) {
                throw failure;
            }
        }
    }

    private PrintStream realErr;
    private ByteArrayOutputStream captured;

    @BeforeEach
    void captureLog() {
        realErr = System.err;
        captured = new ByteArrayOutputStream();
        System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
    }

    @AfterEach
    void restoreLog() {
        System.setErr(realErr);
    }

    private static Heartbeat.Vitals idle() {
        return new Heartbeat.Vitals() {
            @Override public int publishing() { return 0; }

            @Override public int camerasConfigured() { return 1; }

            @Override public List<online.camstream.agent.supervise.Supervisor.TaskHealth> taskHealth() {
                return List.of();
            }

            @Override public Resources.Verdict resources() {
                return new Resources.Verdict(Resources.Constraint.NONE, "", 2);
            }

            @Override public Resources.Snapshot vitalSigns() {
                return Resources.Snapshot.unknown();
            }
        };
    }

    private long count(String log, String needle) {
        return log.lines().filter(line -> line.contains(needle)).count();
    }

    @Test
    @DisplayName("a sustained outage is one line, and recovery says how bad it was")
    void reportsOnceAndCounts() {
        FlakyPublisher publisher = new FlakyPublisher();
        // A clock that advances an hour a tick, so every tick is due and the
        // idle interval does not have to be waited out in real time.
        AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-09-06T00:00:00Z"));
        Heartbeat heartbeat = new Heartbeat(publisher, idle(), "0.1.7",
                Duration.ofMinutes(1), Duration.ofMinutes(15),
                () -> now.getAndUpdate(t -> t.plus(Duration.ofHours(1))));

        publisher.failure = new IllegalStateException("MQTT connection is not established");
        for (int i = 0; i < 30; i++) {
            heartbeat.tick();
        }

        String duringOutage = captured.toString(StandardCharsets.UTF_8);
        assertTrue(publisher.published > 1, "the outage must actually have been retried");
        assertEquals(1, count(duringOutage, "could not publish heartbeat"),
                "an outage should be reported once, log was:\n" + duringOutage);

        publisher.failure = null;
        heartbeat.tick();

        String afterRecovery = captured.toString(StandardCharsets.UTF_8);
        // The count is the part worth keeping: it is the only record of how
        // long the agent went unheard, and it is what turns an alarm into an
        // explanation.
        assertTrue(afterRecovery.matches("(?s).*heartbeat recovered after [1-9]\\d* failure\\(s\\).*"),
                "recovery should carry the failure count, log was:\n" + afterRecovery);
    }

    @Test
    @DisplayName("the failure is visible at the level the agent ships at")
    void isNotDebug() {
        // The whole point. A debug line is not in the log on any real machine,
        // so the previous behaviour was indistinguishable from silence - which
        // is exactly how it presented.
        FlakyPublisher publisher = new FlakyPublisher();
        Heartbeat heartbeat = new Heartbeat(publisher, idle(), "0.1.7",
                Duration.ofMinutes(1), Duration.ofMinutes(15));

        publisher.failure = new IllegalStateException("MQTT connection is not established");
        heartbeat.sendNow();

        String log = captured.toString(StandardCharsets.UTF_8);
        assertTrue(log.contains("WARN"),
                "a heartbeat failure must be at least WARN, log was:\n" + log);
        assertTrue(log.contains("MQTT connection is not established"),
                "and must name the cause, log was:\n" + log);
    }

    @Test
    @DisplayName("a different fault is a new event, even mid-outage")
    void aDifferentFaultIsSaid() {
        // An outage that changes character is a different thing happening. If
        // only the first were ever reported, a credentials failure that turned
        // into a network failure would read as one unbroken event.
        FlakyPublisher publisher = new FlakyPublisher();
        Heartbeat heartbeat = new Heartbeat(publisher, idle(), "0.1.7",
                Duration.ofMinutes(1), Duration.ofMinutes(15));

        publisher.failure = new IllegalStateException("MQTT connection is not established");
        heartbeat.sendNow();
        heartbeat.sendNow();
        publisher.failure = new IllegalStateException("Could not obtain AWS credentials");
        heartbeat.sendNow();

        String log = captured.toString(StandardCharsets.UTF_8);
        assertEquals(2, count(log, "could not publish heartbeat"),
                "each distinct fault should be reported once, log was:\n" + log);
    }

    @Test
    @DisplayName("a healthy agent says nothing about heartbeats at all")
    void silentWhenWell() {
        // The reason this was debug in the first place, and it still holds: a
        // working heartbeat is the normal case and must not write a line every
        // twenty seconds.
        FlakyPublisher publisher = new FlakyPublisher();
        Heartbeat heartbeat = new Heartbeat(publisher, idle(), "0.1.7",
                Duration.ofMinutes(1), Duration.ofMinutes(15));

        heartbeat.sendNow();
        heartbeat.sendNow();

        String log = captured.toString(StandardCharsets.UTF_8);
        assertEquals(0, count(log, "heartbeat"),
                "a working heartbeat should be silent, log was:\n" + log);
    }
}
