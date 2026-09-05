package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Only one sweep of the network at a time.
 *
 * Three things ask for one: the supervised timer, an operator's "scan now", and
 * the rescan that follows new credentials arriving. Nothing stopped them
 * overlapping, and on a real site they did — a restart runs the timer's sweep
 * and then, three seconds later, the credential rescan, because configuration
 * arrives just after start-up.
 *
 * Two sweeps are worse than one in every respect. It is minutes of work done
 * twice; every device on the LAN is probed twice at once, which is enough to
 * make a recorder that is slow to open a stream look broken; and whichever
 * finishes last overwrites the other, so the poorer result wins.
 *
 * Measured on a real network on 2026-09-05: two sweeps three seconds apart, one
 * finding eleven candidate devices and the other three, and the three won. The
 * site had seven. It presented as flaky hardware rather than as a bug here.
 *
 * The assertion counts sweeps rather than returns, deliberately. Both callers
 * return either way — the failure was that both were also *working*, so a test
 * that only checked they came back would pass against the bug it exists for.
 */
class ConcurrentSweepTest {

    private static DiscoveryService discovery() {
        // Nothing to scan and no credentials: the guard is the subject, not the
        // sweep. It still costs a multicast listen, which is what makes this
        // the slowest test in the suite.
        return new DiscoveryService("ffprobe-not-used", "tcp", List.of(), 0, List.of(), id -> List.of());
    }

    @Test
    @DisplayName("two callers at once cause one sweep, and the guard then resets")
    void oneSweepAtATime() throws Exception {
        DiscoveryService discovery = discovery();

        CountDownLatch done = new CountDownLatch(2);
        Runnable ask = () -> {
            discovery.scan();
            done.countDown();
        };
        Thread first = Thread.ofVirtual().start(ask);
        Thread second = Thread.ofVirtual().start(ask);

        assertTrue(done.await(90, TimeUnit.SECONDS), "both callers should return");
        first.join();
        second.join();

        assertEquals(1, discovery.sweepsRun(),
                "two concurrent callers should produce exactly one sweep");

        // And the flag must clear. A guard that latches would turn one sweep
        // into an agent that never discovers anything again — a worse failure
        // than the one being fixed, and invisible until somebody adds a camera.
        discovery.scan();
        assertEquals(2, discovery.sweepsRun(), "a later sweep should still run");
    }
}
