package online.camstream.agent.discovery;

import com.sun.net.httpserver.HttpServer;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Reading a camera's hardware address out of the camera.
 *
 * ARP only sees the local segment, so a camera one routed hop away has no ARP
 * entry at all. Asking the camera itself is what makes a hardware-address
 * identity work beyond a flat network — and the replies vary enough between
 * firmwares to be worth pinning down.
 */
class HardwareAddressTest {

    private HttpServer server;

    private String serve(String responseBody) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/onvif/device_service", exchange -> {
            byte[] body = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/soap+xml");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/onvif/device_service";
    }

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    private static String envelope(String interfaces) {
        return """
            <?xml version="1.0"?>
            <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
                        xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
                        xmlns:tt="http://www.onvif.org/ver10/schema">
              <s:Body><tds:GetNetworkInterfacesResponse>%s</tds:GetNetworkInterfacesResponse></s:Body>
            </s:Envelope>
            """.formatted(interfaces);
    }

    private static String iface(String enabled, String mac) {
        return """
            <tds:NetworkInterfaces token="eth0">
              <tt:Enabled>%s</tt:Enabled>
              <tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>%s</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>
            </tds:NetworkInterfaces>
            """.formatted(enabled, mac);
    }

    private String ask(String body) throws Exception {
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.ipAddress = "127.0.0.1";
        camera.onvifServiceUrl = serve(body);
        return new OnvifClient().hardwareAddress(camera, "admin", "secret");
    }

    @Test
    void readsTheAddressTheCameraReports() throws Exception {
        assertEquals("3c:1e:04:a1:7b:92", ask(envelope(iface("true", "3C:1E:04:A1:7B:92"))));
    }

    @Test
    void normalisesTheSeparatorAndCase() throws Exception {
        // Firmware differs on both. The same camera must not end up with two
        // identities depending on which one answered.
        assertEquals("3c:1e:04:a1:7b:92", ask(envelope(iface("true", "3C-1E-04-A1-7B-92"))));
    }

    @Test
    void prefersAnEnabledInterface() throws Exception {
        // A camera with wired and wireless interfaces reports both, and the
        // one carrying the stream is the one that is up.
        String body = envelope(iface("false", "00:11:22:33:44:55") + iface("true", "3c:1e:04:a1:7b:92"));
        assertEquals("3c:1e:04:a1:7b:92", ask(body));
    }

    @Test
    void takesADisabledInterfaceRatherThanNothing() throws Exception {
        assertEquals("00:11:22:33:44:55", ask(envelope(iface("false", "00:11:22:33:44:55"))));
    }

    @Test
    void ignoresAZeroedAddress() throws Exception {
        // Some firmware reports all-zeros for an unconfigured interface. Taken
        // literally, every such camera would share one identity.
        assertNull(ask(envelope(iface("true", "00:00:00:00:00:00"))));
    }

    @Test
    void ignoresSomethingThatIsNotAnAddress() throws Exception {
        assertNull(ask(envelope(iface("true", "unknown"))));
    }

    @Test
    void returnsNullWhenTheCameraRefuses() throws Exception {
        // GetNetworkInterfaces is restricted to administrators on some
        // firmware. A viewer credential failing here is ordinary.
        DiscoveredCamera camera = new DiscoveredCamera();
        camera.ipAddress = "127.0.0.1";
        camera.onvifServiceUrl = "http://127.0.0.1:1/onvif/device_service";
        assertNull(new OnvifClient().hardwareAddress(camera, "admin", "secret"));
    }

    @Test
    void returnsNullWhenNoInterfaceIsReported() throws Exception {
        assertNull(ask(envelope("")));
    }
}
