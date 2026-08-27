package online.camstream.agent.supervise;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * A slow task must not starve a fast one.
 *
 * The pool was a fixed three for four registered tasks, and the fast one is
 * segment publishing at 250ms while the slow ones are a LAN sweep and an
 * ffprobe per camera. A site large enough to take a while scanning was a site
 * whose segments stopped reaching S3 while it did.
 */
class SupervisorPoolTest {

    @Test
    void keepsRunningTheQuickTaskWhileSlowOnesOccupyThreads() throws Exception {
        try (Supervisor supervisor = new Supervisor(1)) {
            CountDownLatch blocked = new CountDownLatch(3);
            CountDownLatch quickRan = new CountDownLatch(3);

            // Three tasks that seize a thread and hold it.
            for (int i = 0; i < 3; i++) {
                supervisor.supervise(new Supervisor.Task("slow-" + i, Duration.ofSeconds(30), true, () -> {
                    blocked.countDown();
                    try {
                        Thread.sleep(4000);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }));
            }
            assertTrue(blocked.await(5, TimeUnit.SECONDS), "the slow tasks should have started");

            supervisor.supervise(new Supervisor.Task("quick", Duration.ofMillis(100), true, quickRan::countDown));

            assertTrue(quickRan.await(3, TimeUnit.SECONDS),
                    "the quick task must run while the slow ones hold their threads");
        }
    }

    @Test
    void aFailingTaskIsRetriedRatherThanCancelled() throws Exception {
        // What a bare ScheduledExecutorService gets wrong, and the reason this
        // class exists at all.
        try (Supervisor supervisor = new Supervisor(1)) {
            CountDownLatch attempts = new CountDownLatch(2);
            supervisor.supervise(new Supervisor.Task("always-fails", Duration.ofMillis(100), true, () -> {
                attempts.countDown();
                throw new IllegalStateException("boom");
            }));
            assertTrue(attempts.await(5, TimeUnit.SECONDS), "a throwing task must be retried");
            assertFalse(supervisor.health().get(0).healthy());
        }
    }
}
