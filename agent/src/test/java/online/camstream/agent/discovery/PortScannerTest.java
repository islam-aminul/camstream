package online.camstream.agent.discovery;

import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The sweep originally covered only the agent's own subnet, which made cameras
 * on a separate VLAN — the normal arrangement — invisible.
 */
class PortScannerTest {

    @SuppressWarnings("unchecked")
    private static List<String> expand(String cidr) throws Exception {
        Method method = PortScanner.class.getDeclaredMethod("expandCidr", String.class);
        method.setAccessible(true);
        try {
            return (List<String>) method.invoke(null, cidr);
        } catch (InvocationTargetException e) {
            throw (Exception) e.getCause();
        }
    }

    @Test
    void expandsASubnetToItsHostAddresses() throws Exception {
        List<String> hosts = expand("192.168.0.0/24");
        assertEquals(254, hosts.size(), "network and broadcast are excluded");
        assertEquals("192.168.0.1", hosts.get(0));
        assertEquals("192.168.0.254", hosts.get(hosts.size() - 1));
    }

    @Test
    void handlesASmallSubnet() throws Exception {
        // The narrow range used to reach a single camera quickly.
        List<String> hosts = expand("192.168.0.112/29");
        assertEquals(6, hosts.size());
        assertTrue(hosts.contains("192.168.0.113"));
    }

    @Test
    void refusesRangesTooLargeToEnumerate() {
        // A misconfigured /8 would otherwise try to materialise 16 million
        // addresses before anything noticed.
        assertThrows(IllegalArgumentException.class, () -> expand("10.0.0.0/8"));
    }

    @Test
    void refusesMalformedInput() {
        for (String bad : new String[] {"192.168.0.0", "192.168.0.0/", "192.168.0.0/abc", "not-an-address/24"}) {
            assertThrows(IllegalArgumentException.class, () -> expand(bad), bad);
        }
    }
}
