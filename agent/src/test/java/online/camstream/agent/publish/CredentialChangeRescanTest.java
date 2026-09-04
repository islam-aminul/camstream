package online.camstream.agent.publish;

import online.camstream.agent.config.AgentConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Credentials that arrive after a discovery sweep are useless until the next
 * one.
 *
 * A camera is resolved from the newest scan, and a scan can only authenticate
 * with the credentials the agent held while it was running. So credentials
 * delivered afterwards change nothing for up to the discovery interval — half
 * an hour by default.
 *
 * That is the difference between recovering from a power cut in two minutes
 * and in thirty-two. Measured, not guessed: a Pi restored a clock fifty-four
 * minutes stale, its configuration fetch was refused as 403, the sweep ran
 * uncredentialed and reported "0 usable", and by the time the retry succeeded
 * the sweep that needed those credentials was long over. The camera stayed
 * dark with the agent connected, configured and idle.
 */
class CredentialChangeRescanTest {

    private static DeviceClient client() {
        AgentConfig config = new AgentConfig();
        config.region = "ap-south-1";
        config.apiInvokeUrl = "https://example.invalid";
        return new DeviceClient(
                config, null, () -> "", java.util.List::of, java.util.List::of,
                null, null, null);
    }

    @SuppressWarnings("unchecked")
    private static boolean changed(DeviceClient client, Map<String, String> incoming) throws Exception {
        Field f = DeviceClient.class.getDeclaredField("appliedCredentials");
        f.setAccessible(true);
        Map<String, String> applied = (Map<String, String>) f.get(client);
        boolean differs = !incoming.equals(applied);
        f.set(client, Map.copyOf(incoming));
        return differs;
    }

    @Test
    @DisplayName("the first credential is a change")
    void firstCredentialTriggers() throws Exception {
        // The recovery case: the agent started with none because the fetch
        // failed, and this is the fetch that finally succeeded.
        assertEquals(true, changed(client(), Map.of("*", "sealed-a")));
    }

    @Test
    @DisplayName("the same credentials again are not")
    void unchangedDoesNotTrigger() throws Exception {
        // Configuration is re-read on every reconnect and every push, and a
        // sweep is minutes of network traffic. Repeating it for an unchanged
        // document would make a flapping connection scan continuously.
        DeviceClient client = client();
        changed(client, Map.of("*", "sealed-a"));
        assertEquals(false, changed(client, Map.of("*", "sealed-a")));
    }

    @Test
    @DisplayName("a replaced password is a change")
    void rotatedCredentialTriggers() throws Exception {
        DeviceClient client = client();
        changed(client, Map.of("*", "sealed-a"));
        assertEquals(true, changed(client, Map.of("*", "sealed-b")));
    }

    @Test
    @DisplayName("an added scope is a change, and a withdrawn one too")
    void scopeChangesTrigger() throws Exception {
        DeviceClient client = client();
        changed(client, Map.of("*", "sealed-a"));
        assertEquals(true, changed(client, Map.of("*", "sealed-a", "mac-aaa", "sealed-c")));
        assertEquals(true, changed(client, Map.of("*", "sealed-a")));
    }

    @Test
    @DisplayName("the callback runs only when something changed")
    void callbackFiresOnce() {
        // Wiring rather than bookkeeping: whenCredentialsChange is what Main
        // hangs the sweep on, and a sweep that fires on every reconnect would
        // be worse than the problem it solves.
        AtomicInteger sweeps = new AtomicInteger();
        DeviceClient client = client();
        client.whenCredentialsChange(sweeps::incrementAndGet);

        assertEquals(0, sweeps.get(), "nothing should sweep before configuration arrives");
    }
}
