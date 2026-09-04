package online.camstream.agent.publish;

import online.camstream.agent.config.AgentConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * An agent that could not fetch its configuration has to keep asking.
 *
 * Configuration arrives two ways, and both are events: a fetch when the agent
 * connects, and a push when the control plane changes something. If the fetch
 * on connect fails and no push happens to follow, nothing tries again — and
 * the agent runs indefinitely with no credentials and no cameras while looking
 * entirely healthy. Connected. Heartbeating. Discovering devices it cannot
 * authenticate against, and reporting them as needing credentials.
 *
 * A Raspberry Pi with no clock battery booted thirty-nine days behind. Every
 * signed request was refused with a bare 403, the config fetch on connect was
 * one of them, and the agent sat inert for a day. The console said the camera
 * was registered but its agent had not reported it, which sent the search
 * towards the camera and its credentials — both of which were fine.
 *
 * Nothing about that is specific to clocks. A throttle, a 5xx or a network
 * blip during start-up produces exactly the same permanent silence.
 */
class ConfigurationRetryTest {

    private static DeviceClient client() {
        AgentConfig config = new AgentConfig();
        config.region = "ap-south-1";
        config.apiInvokeUrl = "https://example.invalid";
        // Never connected: enough to inspect the state machine, which is what
        // this is about. The transport is exercised against the real control
        // plane, not here.
        return new DeviceClient(
                config, null, () -> "", java.util.List::of, java.util.List::of,
                null, null, null);
    }

    private static void set(DeviceClient client, String field, Object value) throws Exception {
        Field f = DeviceClient.class.getDeclaredField(field);
        f.setAccessible(true);
        f.set(client, value);
    }

    @Test
    @DisplayName("a fresh agent is owed its configuration")
    void freshAgentNeedsConfiguration() {
        assertTrue(client().needsConfiguration(),
                "an agent that has never fetched must ask, or it never will");
    }

    @Test
    @DisplayName("a configured agent stops asking")
    void configuredAgentIsQuiet() throws Exception {
        DeviceClient client = client();
        set(client, "configVersion", 7L);
        set(client, "configurationOwed", false);

        assertFalse(client.needsConfiguration(),
                "retrying forever would be a request a minute for the life of the agent");
    }

    @Test
    @DisplayName("a failed fetch puts the agent back in debt")
    void failureIsRemembered() throws Exception {
        // The case that mattered: a version had been fetched successfully at
        // some point, then a later fetch failed. Judging only on configVersion
        // would call this configured and stop asking, holding a document the
        // control plane has since replaced.
        DeviceClient client = client();
        set(client, "configVersion", 7L);
        set(client, "configurationOwed", true);

        assertTrue(client.needsConfiguration());
    }
}
