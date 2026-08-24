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

        State(Task task) {
            this.task = task;
        }
    }

    private final ScheduledExecutorService scheduler;
    private final List<State> states = new CopyOnWriteArrayList<>();
    private volatile boolean running = true;

    public Supervisor(int threads) {
        this.scheduler = Executors.newScheduledThreadPool(threads, runnable -> {
            Thread thread = new Thread(runnable);
            thread.setDaemon(true);
            thread.setName("camstream-supervisor");
            return thread;
        });
    }

    /** Registers a task and starts it after one interval. */
    public void supervise(Task task) {
        State state = new State(task);
        states.add(state);
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
        scheduler.shutdownNow();
    }
}
