package online.camstream.agent.supervise;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A task that stops coming back says so, and says what it was doing.
 *
 * The supervisor handles a task that *throws* well: caught, logged, backed off,
 * retried. A task that *blocks* it does not handle at all. It never reaches the
 * finally that reschedules it, never records a failure, and simply stops — so
 * the agent goes silent while every outward sign, including its own last
 * heartbeat, still says healthy.
 *
 * That is not hypothetical. On 2026-09-06 an agent came back from a laptop
 * suspend unable to obtain AWS credentials and said nothing whatsoever for
 * twenty-six minutes. Not one error line. It was fixed by a restart, which
 * also destroyed the evidence — the attempt to take a thread dump from outside
 * killed the JVM, because the service runs as an account no ordinary user may
 * attach to.
 *
 * So the agent dumps its own threads. That needs no attach, no matching JDK and
 * no privilege. This does not fix the underlying fault, which is still unknown;
 * it makes the next occurrence explain itself rather than costing another
 * incident.
 */
class StuckTaskTest {

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

    /** How many stuck episodes have been reported so far. */
    private long episodes() {
        return captured.toString(StandardCharsets.UTF_8).lines()
                .filter(line -> line.contains("has been running for")).count();
    }

    /**
     * A supervisor whose patience has been spent, so the watchdog's own
     * judgement is what is under test rather than a five-minute wait.
     *
     * checkForStuckTasks is called directly for the same reason: the watchdog
     * runs once a minute in production, and a test that waited for it would be
     * a minute long and would still be testing the scheduler rather than the
     * decision.
     */
    @Test
    @DisplayName("a task that blocks for ever is reported, with the stack that is blocking")
    void reportsABlockedTask() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        try (Supervisor supervisor = new Supervisor(2)) {
            supervisor.supervise(new Supervisor.Task("wedged", Duration.ofMillis(10), true, () -> {
                entered.countDown();
                try {
                    // Blocks exactly as a credentials fetch on a dead socket
                    // would: in the task body, holding its thread, throwing
                    // nothing.
                    release.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }));

            assertTrue(entered.await(5, TimeUnit.SECONDS), "the task should have started");
            // Wait past the minimum patience by moving the goalposts rather
            // than the clock: five real minutes is not a test.
            Thread.sleep(50);
            supervisor.checkForStuckTasks();

            String log = captured.toString(StandardCharsets.UTF_8);
            assertFalse(log.contains("has been running for"),
                    "nothing should be reported before the patience is spent, log was:\n" + log);

            supervisor.checkForStuckTasks(Duration.ZERO);
            log = captured.toString(StandardCharsets.UTF_8);
            assertTrue(log.contains("[wedged] has been running for"),
                    "a blocked task should be named, log was:\n" + log);
            assertTrue(log.contains("thread(s)"), "the dump should be attached, log was:\n" + log);
            // The frame that is actually stuck. A dump that did not include it
            // would name the task and still not say where it was.
            assertTrue(log.contains("CountDownLatch") || log.contains("AbstractQueuedSynchronizer"),
                    "the dump should show where it is blocked, log was:\n" + log);

            release.countDown();
        }
    }

    @Test
    @DisplayName("one stuck episode is one dump, not one a minute for ever")
    void reportsOnce() throws Exception {
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        try (Supervisor supervisor = new Supervisor(2)) {
            supervisor.supervise(new Supervisor.Task("wedged", Duration.ofMillis(10), true, () -> {
                entered.countDown();
                try {
                    release.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }));
            assertTrue(entered.await(5, TimeUnit.SECONDS));

            for (int i = 0; i < 5; i++) {
                supervisor.checkForStuckTasks(Duration.ZERO);
            }

            String log = captured.toString(StandardCharsets.UTF_8);
            // A thread dump is thousands of lines. Repeating it every minute
            // through an overnight outage would bury the first one, which is
            // the only one that describes how the agent got there.
            assertEquals(1, log.lines().filter(l -> l.contains("has been running for")).count(),
                    "an episode should be dumped once, log was:\n" + log);

            release.countDown();
        }
    }

    @Test
    @DisplayName("a second stuck episode is reported, so the flag cannot latch")
    void rearmsAfterRecovery() throws Exception {
        // Asserting only that a *recovered* task goes quiet is not enough: that
        // passes just as well against a flag that latches for ever, because a
        // latched flag also produces silence. The failure that matters is the
        // second episode - an agent that wedges, recovers, and wedges again
        // that night, with only the first one ever described.
        AtomicInteger runs = new AtomicInteger();
        AtomicReference<CountDownLatch> gate = new AtomicReference<>(new CountDownLatch(1));

        try (Supervisor supervisor = new Supervisor(2)) {
            supervisor.supervise(new Supervisor.Task("flaky", Duration.ofMillis(10), true, () -> {
                int run = runs.incrementAndGet();
                // Blocks on the first and third runs; sails through otherwise.
                if (run == 1 || run == 3) {
                    try {
                        gate.get().await();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
            }));

            // First episode.
            while (runs.get() < 1) {
                Thread.sleep(5);
            }
            supervisor.checkForStuckTasks(Duration.ZERO);
            assertEquals(1, episodes(), "the first episode should be reported");

            // Let it go, and let it come back cleanly so the flag can clear.
            CountDownLatch first = gate.getAndSet(new CountDownLatch(1));
            first.countDown();
            while (runs.get() < 3) {
                Thread.sleep(5);
            }

            // Second episode, on the same task.
            supervisor.checkForStuckTasks(Duration.ZERO);
            assertEquals(2, episodes(),
                    "a second episode must be reported too, log was: "
                            + captured.toString(StandardCharsets.UTF_8));

            gate.get().countDown();
        }
    }

    @Test
    @DisplayName("healthy tasks are never dumped")
    void quietWhenWell() throws Exception {
        AtomicInteger runs = new AtomicInteger();
        try (Supervisor supervisor = new Supervisor(2)) {
            supervisor.supervise(new Supervisor.Task(
                    "fine", Duration.ofMillis(10), true, runs::incrementAndGet));
            while (runs.get() < 3) {
                Thread.sleep(10);
            }
            supervisor.checkForStuckTasks(Duration.ZERO);

            String log = captured.toString(StandardCharsets.UTF_8);
            assertFalse(log.contains("has been running for"),
                    "a working agent must never write a thread dump, log was:\n" + log);
        }
    }

    @Test
    @DisplayName("the watchdog reports even when every pool thread is blocked")
    void survivesAFullyBlockedPool() throws Exception {
        // The reason the watchdog owns a thread instead of sharing the pool.
        //
        // Tasks wedge by occupying a pool thread and never giving it back. A
        // watchdog scheduled on that same pool would be queued behind exactly
        // the tasks it exists to report on, and would fall silent at the same
        // moment they did - a smoke alarm wired to the circuit that is on fire.
        //
        // Every other test here calls the check directly, which cannot show
        // this. This one starves the pool completely and waits for the
        // watchdog to speak by itself.
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        // One thread, one task, and that task never returns: the pool has
        // nothing left to run anything on.
        try (Supervisor supervisor = new Supervisor(1, Duration.ofMillis(50), Duration.ZERO)) {
            supervisor.supervise(new Supervisor.Task("hog", Duration.ofMillis(10), true, () -> {
                entered.countDown();
                try {
                    release.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }));
            assertTrue(entered.await(5, TimeUnit.SECONDS), "the task should have started");

            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (episodes() == 0 && System.nanoTime() < deadline) {
                Thread.sleep(25);
            }
            assertEquals(1, episodes(),
                    "the watchdog must fire while the pool is fully blocked, log was: "
                            + captured.toString(StandardCharsets.UTF_8));

            release.countDown();
        }
    }

    @Test
    @DisplayName("patience scales with the task's own cadence, but never below five minutes")
    void patienceIsProportionate() {
        // Publishing runs every 250ms and a slow upload is ordinary; discovery
        // runs every thirty minutes and a LAN sweep legitimately takes several.
        // One fixed threshold cannot serve both, and the floor is what stops
        // the fast one being called stuck for doing its job.
        assertEquals(Duration.ofMinutes(5), Supervisor.patienceFor(Duration.ofMillis(250)));
        assertEquals(Duration.ofMinutes(5), Supervisor.patienceFor(Duration.ofSeconds(20)));
        assertEquals(Duration.ofMinutes(90), Supervisor.patienceFor(Duration.ofMinutes(30)));
    }
}
