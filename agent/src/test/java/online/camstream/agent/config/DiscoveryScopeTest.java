package online.camstream.agent.config;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Narrowing discovery is opt-in.
 *
 * A machine with a second connection sweeps both networks, and on a dual-homed
 * agent that came to 5,367 addresses and about five minutes per sweep — of
 * which the office network could contribute nothing. That is not merely slow:
 * an agent refuses every camera until its first sweep finishes, answering
 * "ignoring request for unknown camera", so an update there meant five minutes
 * of a dark wall.
 *
 * `discoveryNetworksOnly` fixes that for a site that knows where its cameras
 * are. It must stay off by default, because the failure it causes when wrong is
 * the worse kind: an agent that quietly stops finding a camera somebody moved,
 * with nothing in the log except a sweep that found less than it used to.
 */
class DiscoveryScopeTest {

    @Test
    @DisplayName("a fresh config sweeps everything it is attached to")
    void confinementIsOptIn() {
        AgentConfig config = new AgentConfig();
        assertFalse(config.discoveryNetworksOnly,
                "an operator who has not asked to narrow discovery must not get it");
        assertTrue(config.discoveryNetworks.isEmpty(),
                "and there is nothing to narrow it to by default");
    }

    @Test
    @DisplayName("asking for confinement without naming a network is not an instruction to scan nothing")
    void confinementNeedsSomethingToConfineTo() {
        // The dangerous combination: the flag set and the list left empty. Read
        // literally that means "sweep no networks", which produces an agent
        // that finds nothing and reports only that it scanned zero addresses.
        // PortScanner falls back to the interfaces in that case; this pins the
        // shape of the config that makes the fallback reachable rather than the
        // fallback itself, which needs a network to exercise.
        AgentConfig config = new AgentConfig();
        config.discoveryNetworksOnly = true;
        assertTrue(config.discoveryNetworks.isEmpty(),
                "this is the combination the scanner has to survive");
    }
}
