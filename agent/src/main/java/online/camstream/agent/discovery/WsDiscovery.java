package online.camstream.agent.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;

import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * ONVIF WS-Discovery: a multicast probe that makes conforming cameras announce
 * themselves.
 *
 * This runs before any credential is involved, which is the point — an
 * installer can see what is on the network, and only then decide what to
 * authenticate against. Cameras that ignore multicast are picked up afterwards
 * by {@link PortScanner}.
 */
final class WsDiscovery {

    private static final Logger log = LoggerFactory.getLogger(WsDiscovery.class);

    private static final String MULTICAST_ADDRESS = "239.255.255.250";
    private static final int MULTICAST_PORT = 3702;

    /** Cameras answer within a second or two; the rest of the wait is for stragglers. */
    private static final int LISTEN_MILLIS = 4000;

    private WsDiscovery() {
    }

    /** ONVIF service URLs found on the network, keyed by host. */
    static Map<String, String> probe() {
        Map<String, String> byHost = new LinkedHashMap<>();
        for (NetworkInterface nic : usableInterfaces()) {
            try {
                byHost.putAll(probeOn(nic));
            } catch (Exception e) {
                log.debug("WS-Discovery failed on {}: {}", nic.getName(), e.toString());
            }
        }
        return byHost;
    }

    private static Map<String, String> probeOn(NetworkInterface nic) throws Exception {
        Map<String, String> found = new LinkedHashMap<>();
        String messageId = "uuid:" + UUID.randomUUID();
        byte[] request = Xml.utf8(probeMessage(messageId));

        try (MulticastSocket socket = new MulticastSocket()) {
            socket.setNetworkInterface(nic);
            socket.setSoTimeout(500);
            socket.send(new DatagramPacket(request, request.length,
                    new InetSocketAddress(InetAddress.getByName(MULTICAST_ADDRESS), MULTICAST_PORT)));

            long deadline = System.currentTimeMillis() + LISTEN_MILLIS;
            byte[] buffer = new byte[16384];
            while (System.currentTimeMillis() < deadline) {
                DatagramPacket response = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(response);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                byte[] payload = new byte[response.getLength()];
                System.arraycopy(response.getData(), 0, payload, 0, response.getLength());
                try {
                    for (String address : serviceAddresses(payload)) {
                        String host = URI.create(address).getHost();
                        if (host != null) {
                            found.putIfAbsent(host, address);
                        }
                    }
                } catch (Exception e) {
                    log.debug("unparseable ProbeMatch from {}: {}", response.getAddress(), e.toString());
                }
            }
        }
        if (!found.isEmpty()) {
            log.info("WS-Discovery found {} device(s) on {}", found.size(), nic.getName());
        }
        return found;
    }

    /**
     * XAddrs is a space-separated list; prefer an http(s) entry and skip the
     * IPv6 link-local forms some cameras advertise but do not serve.
     */
    private static List<String> serviceAddresses(byte[] payload) throws Exception {
        Document document = Xml.parse(payload);
        List<String> addresses = new ArrayList<>();
        for (Element xaddrs : Xml.elements(document, "XAddrs")) {
            for (String candidate : xaddrs.getTextContent().trim().split("\\s+")) {
                if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
                    addresses.add(candidate);
                }
            }
        }
        return addresses;
    }

    private static String probeMessage(String messageId) {
        return """
            <?xml version="1.0" encoding="UTF-8"?>
            <e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
                        xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
                        xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
                        xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
              <e:Header>
                <w:MessageID>%s</w:MessageID>
                <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
                <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
              </e:Header>
              <e:Body>
                <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
              </e:Body>
            </e:Envelope>
            """.formatted(messageId);
    }

    /** Interfaces worth probing: up, multicast-capable, not loopback or virtual. */
    static List<NetworkInterface> usableInterfaces() {
        List<NetworkInterface> usable = new ArrayList<>();
        try {
            for (NetworkInterface nic : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (nic.isUp() && !nic.isLoopback() && nic.supportsMulticast() && !nic.isVirtual()) {
                    usable.add(nic);
                }
            }
        } catch (Exception e) {
            log.warn("could not enumerate network interfaces: {}", e.toString());
        }
        return usable;
    }
}
