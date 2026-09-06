package online.camstream.agent.supervise;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Runs the agent's long-lived work and keeps it running.
 *
 * An unattended box on someone else's network cannot rely on a human noticing
 * that a task died. Every subsystem — segment publishing, heartbeats, camera
 * discovery — is registered here rather than scheduled directly, so a task that
 * throws is logged, backed off and retried instead of being silently cancelled,
 * which is what a bare {@code ScheduledExecutorService} does with a failing
 * periodic task.
 */
public final class Supervisor implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Supervisor.class);

    private static final Duration MIN_BACKOFF = Duration.ofSeconds(1);
    private static final Duration MAX_BACKOFF = Duration.ofMinutes(2);
    /** A task running this long before failing counts as having recovered. */
    private static final Duration HEALTHY_AFTER = Duration.ofMinutes(5);

    /** No task is called stuck sooner than this, whatever its cadence. */
    private static final Duration MIN_PATIENCE = Duration.ofMinutes(5);

    /** How often the watchdog looks. Cheap: a few volatile reads. */
    private static final Duration WATCHDOG_INTERVAL = Duration.ofMinutes(1);

    /**
     * A supervised unit of work, retried on failure.
     *
     * @param runImmediately whether to run once on registration rather than
     *                       waiting a full interval. Useful for slow periodic
     *                       work like discovery, where the first result should
     *                       not be minutes away.
     */
    public record Task(String name, Duration interval, boolean runImmediately, Runnable body) {
        public Task(String name, Duration interval, Runnable body) {
            this(name, interval, false, body);
        }

        public Task {
            if (name == null || name.isBlank()) {
                throw new IllegalArgumentException("task name is required");
            }
            if (interval == null || interval.isNegative() || interval.isZero()) {
                throw new IllegalArgumentException("task " + name + " needs a positive interval");
            }
            if (body == null) {
                throw new IllegalArgumentException("task " + name + " needs a body");
            }
        }
    }

    private static final class State {
        final Task task;
        final Backoff backoff = new Backoff(MIN_BACKOFF, MAX_BACKOFF, HEALTHY_AFTER);
        Instant lastSuccess = Instant.now();
        /** When the current run began, or null when this task is not running. */
        volatile Instant startedAt;
        /** So one stuck episode is one dump, not one a minute for ever. */
        volatile boolean stuckReported;

        State(Task task) {
            this.task = task;
        }

        Duration patience() {
            return patienceFor(task.interval());
        }
    }

    private final ScheduledExecutorService scheduler;
    /**
     * The watchdog's own thread, and it must be its own.
     *
     * It exists to notice tasks that have stopped coming back, and the way
     * they stop coming back is by occupying a pool thread for ever. A watchdog
     * sharing that pool would be queued behind exactly the tasks it is meant
     * to report on, and would go quiet at the same moment they did.
     */
    private final ScheduledExecutorService watchdog;
    /** Overrides each task's patience, for tests only; null in production. */
    private final Duration watchdogPatience;
    private final List<State> states = new CopyOnWriteArrayList<>();
    private volatile boolean running = true;

    public Supervisor(int threads) {
        this(threads, WATCHDOG_INTERVAL, null);
    }

    /**
     * @param watchdogInterval how often to look for stuck tasks
     * @param watchdogPatience how long a run may take before it counts as
     *   stuck, or null to use each task's own. Both exist so a test can prove
     *   the watchdog fires *on its own thread* while every pool thread is
     *   blocked - which is the whole reason it has one, and cannot be shown by
     *   calling the check directly.
     */
    Supervisor(int threads, Duration watchdogInterval, Duration watchdogPatience) {
        this.watchdogPatience = watchdogPatience;
        this.scheduler = Executors.newScheduledThreadPool(threads, runnable -> {
            Thread thread = new Thread(runnable);
            thread.setDaemon(true);
            thread.setName("camstream-supervisor");
            return thread;
        });
        this.watchdog = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable);
            thread.setDaemon(true);
            thread.setName("camstream-watchdog");
            return thread;
        });
        this.watchdog.scheduleWithFixedDelay(() -> checkForStuckTasks(this.watchdogPatience),
                watchdogInterval.toMillis(), watchdogInterval.toMillis(), TimeUnit.MILLISECONDS);
    }

    /**
     * How long a run may take before it is treated as stuck.
     *
     * Three intervals, because a task that has taken three times its own
     * cadence is late by its own standard rather than by a number chosen here
     * — but never less than five minutes, so publishing at 250ms is not called
     * stuck for one slow upload.
     */
    static Duration patienceFor(Duration interval) {
        Duration byCadence = interval.multipliedBy(3);
        return byCadence.compareTo(MIN_PATIENCE) > 0 ? byCadence : MIN_PATIENCE;
    }

    /**
     * Reports tasks that went in and never came out.
     *
     * The failure this exists for: on 2026-09-06 an agent came back from a
     * laptop suspend unable to obtain AWS credentials, and then said nothing
     * whatsoever for twenty-six minutes. Not one error — silence. A task that
     * throws is caught, logged, backed off and retried by execute() below; a
     * task that *blocks* is none of those things. It never reaches the finally
     * that reschedules it, never records a failure, and simply stops, leaving
     * an agent that looks connected and healthy from every angle including its
     * own last heartbeat.
     *
     * There is no fix here, deliberately. What went wrong that morning is
     * still unknown, and the attempt to find out by attaching a debugger
     * killed the process and ended the incident. This makes the next
     * occurrence explain itself instead.
     */
    void checkForStuckTasks() {
        checkForStuckTasks(null);
    }

    /**
     * @param patience overrides each task's own, for tests. Waiting out the
     *   real five minutes would make this untestable, and a watchdog nobody
     *   has watched work is a watchdog that fires into a void on the night it
     *   is needed.
     */
    void checkForStuckTasks(Duration patience) {
        if (!running) {
            return;
        }
        Instant now = Instant.now();
        for (State state : states) {
            Instant started = state.startedAt;
            if (started == null) {
                // Not running: nothing to judge. The flag is cleared by
                // execute() when the run actually returns, not here.
                continue;
            }
            Duration allowed = patience != null ? patience : state.patience();
            if (state.stuckReported || Duration.between(started, now).compareTo(allowed) < 0) {
                continue;
            }
            state.stuckReported = true;
            log.error("[{}] has been running for {}s without returning, which is longer than "
                            + "anything it should do. Dumping threads — see docs/pending.md.{}{}",
                    state.task.name(), Duration.between(started, now).toSeconds(),
                    System.lineSeparator(), ThreadDump.take());
        }
    }

    /** Registers a task and starts it after one interval. */
    public void supervise(Task task) {
        State state = new State(task);
        states.add(state);
        // One thread per registered task, so a slow one cannot starve a fast
        // one. The pool was a fixed three for four tasks, and the fast one is
        // segment publishing at 250ms while the slow ones are a LAN sweep and
        // an ffprobe per camera — so a site large enough to scan for a while
        // was a site whose segments stopped being uploaded while it did.
        if (scheduler instanceof java.util.concurrent.ScheduledThreadPoolExecutor pool
                && pool.getCorePoolSize() < states.size()) {
            pool.setCorePoolSize(states.size());
        }
        schedule(state, task.runImmediately() ? Duration.ZERO : task.interval());
        log.info("supervising \"{}\" every {}", task.name(), describe(task.interval()));
    }

    /** Sub-second intervals are common here, and "0s" reads as broken. */
    private static String describe(Duration interval) {
        return interval.toMillis() < 1000
                ? interval.toMillis() + "ms"
                : interval.toSeconds() + "s";
    }

    /** Runs a task once, now, on the caller's thread, reporting failure as false. */
    public boolean runOnce(Task task) {
        try {
            task.body().run();
            return true;
        } catch (RuntimeException e) {
            log.warn("[{}] failed: {}", task.name(), e.toString());
            return false;
        }
    }

    private void schedule(State state, Duration delay) {
        if (!running) {
            return;
        }
        scheduler.schedule(() -> execute(state), delay.toMillis(), TimeUnit.MILLISECONDS);
    }

    private void execute(State state) {
        if (!running) {
            return;
        }
        Duration next = state.task.interval();
        state.backoff.started();
        state.startedAt = Instant.now();
        try {
            state.task.body().run();
            if (!state.backoff.healthy()) {
                log.info("[{}] recovered after {} failure(s)",
                        state.task.name(), state.backoff.consecutiveFailures());
            }
            state.backoff.succeeded();
            state.lastSuccess = Instant.now();
        } catch (Throwable e) {
            // Throwable, not Exception: an Error in one task must not take the
            // supervisor's thread with it.
            Duration penalty = state.backoff.failed();
            // Never retry faster than the task's own cadence.
            next = penalty.compareTo(state.task.interval()) > 0 ? penalty : state.task.interval();
            log.warn("[{}] failed ({} in a row), next attempt in {}s: {}",
                    state.task.name(), state.backoff.consecutiveFailures(), next.toSeconds(), e.toString());
        } finally {
            state.startedAt = null;
            // Re-armed here, by the task itself, rather than by the watchdog
            // noticing it idle. The watchdog looks once a minute, so a task
            // that wedged, recovered and wedged again between two looks would
            // otherwise have its second episode silently swallowed - and a
            // fault that comes and goes is exactly the kind worth catching
            // twice.
            state.stuckReported = false;
            schedule(state, next);
        }
    }

    /** Snapshot for diagnostics and the heartbeat payload. */
    public List<TaskHealth> health() {
        List<TaskHealth> out = new ArrayList<>(states.size());
        for (State state : states) {
            out.add(new TaskHealth(
                    state.task.name(),
                    state.backoff.healthy(),
                    state.backoff.consecutiveFailures(),
                    state.lastSuccess));
        }
        return out;
    }

    public record TaskHealth(String name, boolean healthy, int consecutiveFailures, Instant lastSuccess) {}

    @Override
    public void close() {
        running = false;
        watchdog.shutdownNow();
        scheduler.shutdownNow();
    }
}
