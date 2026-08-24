package online.camstream.agent.supervise;

import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.*;

class BackoffTest {

    private static Backoff backoff() {
        return new Backoff(Duration.ofSeconds(1), Duration.ofSeconds(30), Duration.ofSeconds(60));
    }

    @Test
    void doublesThenCaps() {
        Backoff backoff = backoff();
        assertEquals(1, backoff.failed().toSeconds());
        assertEquals(2, backoff.failed().toSeconds());
        assertEquals(4, backoff.failed().toSeconds());
        assertEquals(8, backoff.failed().toSeconds());
        assertEquals(16, backoff.failed().toSeconds());
        assertEquals(30, backoff.failed().toSeconds());
        // Once capped it stays capped rather than overflowing the shift.
        for (int i = 0; i < 40; i++) {
            assertEquals(30, backoff.failed().toSeconds());
        }
    }

    @Test
    void successResetsTheDelay() {
        Backoff backoff = backoff();
        backoff.failed();
        backoff.failed();
        assertFalse(backoff.healthy());

        backoff.succeeded();
        assertTrue(backoff.healthy());
        assertEquals(0, backoff.consecutiveFailures());
        assertEquals(1, backoff.failed().toSeconds(), "should start again from the minimum");
    }

    @Test
    void anAttemptThatRanLongEnoughIsTreatedAsAFreshFault() throws Exception {
        // A camera that drops once an hour must not creep up to the cap and
        // stay there.
        Backoff backoff = new Backoff(Duration.ofSeconds(1), Duration.ofSeconds(30), Duration.ofMillis(50));
        backoff.failed();
        backoff.failed();
        backoff.failed();
        assertEquals(3, backoff.consecutiveFailures());

        backoff.started();
        Thread.sleep(80);
        assertEquals(1, backoff.failed().toSeconds(), "a healthy run should clear the accumulated penalty");
        assertEquals(1, backoff.consecutiveFailures());
    }
}
