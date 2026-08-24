package online.camstream.agent.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * TCP sweep for cameras that do not answer WS-Discovery — which is most cheap
 * ones, and any camera on a network where multicast is filtered.
 *
 * This is a connect scan of the agent's own subnets only. It never scans beyond
 * a /22, both because a surveillance LAN is never larger and because an agent
 * quietly sweeping a corporate /16 is indistinguishable from an intruder.
 */
final class PortScanner {

    private static final Logger log = LoggerFactory.getLogger(PortScanner.class);

    /** ONVIF device service; 80 and 8000 are common vendor variations. */
    static final List<Integer> ONVIF_PORTS = List.of(80, 8080, 8000, 8899, 2020);
    static final List<Integer> RTSP_PORTS = List.of(554, 8554, 10554);

    private static final int CONNECT_TIMEOUT_MS = 400;
    private static final int MAX_HOSTS = 1024;

    private PortScanner() {
    }

    record OpenPorts(String host, List<Integer> onvif, List<Integer> rtsp) {
        boolean any() {
            return !onvif.isEmpty() || !rtsp.isEmpty();
        }
    }

    /** Scans every local IPv4 subnet, returning only hosts with a camera-ish port open. */
    static Map<String, OpenPorts> scan() {
        List<String> hosts = localHosts();
        if (hosts.isEmpty()) {
            return Map.of();
        }
        log.info("scanning {} address(es) for camera ports", hosts.size());

        Map<String, OpenPorts> results = new LinkedHashMap<>();
        // Virtual threads: this workload is almost entirely blocked on connect
        // timeouts, so platform threads would be pure overhead.
        try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Callable<OpenPorts>> jobs = new ArrayList<>(hosts.size());
            for (String host : hosts) {
                jobs.add(() -> probeHost(host));
            }
            for (Future<OpenPorts> future : pool.invokeAll(jobs, 2, TimeUnit.MINUTES)) {
                try {
                    OpenPorts open = future.get();
                    if (open != null && open.any()) {
                        results.put(open.host(), open);
                    }
                } catch (Exception e) {
                    // A single unreachable host is not worth a log line.
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        log.info("port scan found {} candidate device(s)", results.size());
        return results;
    }

    private static OpenPorts probeHost(String host) {
        List<Integer> onvif = new ArrayList<>();
        List<Integer> rtsp = new ArrayList<>();
        for (int port : ONVIF_PORTS) {
            if (isOpen(host, port)) {
                onvif.add(port);
            }
        }
        for (int port : RTSP_PORTS) {
            if (isOpen(host, port)) {
                rtsp.add(port);
            }
        }
        return new OpenPorts(host, onvif, rtsp);
    }

    private static boolean isOpen(String host, int port) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Every IPv4 host address on the agent's own subnets, excluding itself. */
    static List<String> localHosts() {
        List<String> hosts = new ArrayList<>();
        for (NetworkInterface nic : WsDiscovery.usableInterfaces()) {
            for (InterfaceAddress address : nic.getInterfaceAddresses()) {
                InetAddress local = address.getAddress();
                if (!(local instanceof java.net.Inet4Address) || local.isLoopbackAddress()) {
                    continue;
                }
                int prefix = address.getNetworkPrefixLength();
                if (prefix < 22 || prefix > 30) {
                    log.debug("skipping {}/{} — outside the scannable range", local.getHostAddress(), prefix);
                    continue;
                }
                hosts.addAll(expand(local, prefix));
                if (hosts.size() >= MAX_HOSTS) {
                    return hosts.subList(0, MAX_HOSTS);
                }
            }
        }
        return hosts;
    }

    private static List<String> expand(InetAddress local, int prefixLength) {
        byte[] raw = local.getAddress();
        int address = ((raw[0] & 0xff) << 24) | ((raw[1] & 0xff) << 16) | ((raw[2] & 0xff) << 8) | (raw[3] & 0xff);
        int mask = prefixLength == 0 ? 0 : -1 << (32 - prefixLength);
        int network = address & mask;
        int broadcast = network | ~mask;

        List<String> hosts = new ArrayList<>();
        for (int host = network + 1; host < broadcast; host++) {
            if (host == address) {
                continue;
            }
            hosts.add(String.format("%d.%d.%d.%d",
                    (host >>> 24) & 0xff, (host >>> 16) & 0xff, (host >>> 8) & 0xff, host & 0xff));
        }
        return hosts;
    }
}
