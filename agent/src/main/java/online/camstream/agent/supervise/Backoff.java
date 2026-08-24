package online.camstream.agent.supervise;

import java.time.Duration;
import java.time.Instant;

/**
 * Exponential retry delay, capped, with recovery.
 *
 * Shared by the two things in the agent that restart on failure: the
 * {@link Supervisor}'s periodic tasks, and the ffmpeg process per rendition.
 * They supervise different shapes of work — one is a repeating call, the other
 * a long-lived child process — but the retry policy should not differ between
 * them, and previously it was implemented twice.
 */
public final class Backoff {

    private final Duration min;
    private final Duration max;
    private final Duration healthyAfter;

    private int consecutiveFailures;
    private Instant startedAt = Instant.now();

    public Backoff(Duration min, Duration max, Duration healthyAfter) {
        this.min = min;
        this.max = max;
        this.healthyAfter = healthyAfter;
    }

    /** Marks the start of an attempt, so its lifetime can be judged on failure. */
    public void started() {
        startedAt = Instant.now();
    }

    /**
     * Records a failure and returns how long to wait.
     *
     * An attempt that survived {@code healthyAfter} is treated as a fresh
     * fault rather than a continuation, so a camera that drops once an hour
     * does not creep up to the maximum delay and stay there.
     */
    public Duration failed() {
        if (Duration.between(startedAt, Instant.now()).compareTo(healthyAfter) > 0) {
            consecutiveFailures = 0;
        }
        consecutiveFailures++;
        long seconds = min.toSeconds() << Math.min(consecutiveFailures - 1, 16);
        return Duration.ofSeconds(Math.min(Math.max(seconds, min.toSeconds()), max.toSeconds()));
    }

    public void succeeded() {
        consecutiveFailures = 0;
        startedAt = Instant.now();
    }

    public int consecutiveFailures() {
        return consecutiveFailures;
    }

    public boolean healthy() {
        return consecutiveFailures == 0;
    }
}
