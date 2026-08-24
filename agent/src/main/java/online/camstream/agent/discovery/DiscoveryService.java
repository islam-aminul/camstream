package online.camstream.agent.discovery;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Finds cameras on the local network and works out how to stream from them.
 *
 * Runs entirely on-premises. Credentials are tried here and the resulting RTSP
 * URLs — which embed those credentials — stay here; only redacted metadata is
 * ever handed to the caller for reporting upward.
 */
public final class DiscoveryService {

    private static final Logger log = LoggerFactory.getLogger(DiscoveryService.class);

    private final OnvifClient onvif = new OnvifClient();
    private final RtspProbe rtspProbe;
    private final RtspPathGuesser pathGuesser;
    /** Credentials to try for a given camera identity, most specific first. */
    private final java.util.function.Function<String, List<Credential>> credentials;
    private final String rtspTransport;
    private final int maxHosts;

    /** Last full result, including credential-bearing URLs. Never leaves the agent. */
    private volatile Map<String, DiscoveredCamera> lastScan = Map.of();

    public DiscoveryService(
            String ffprobePath,
            String rtspTransport,
            List<String> rtspPaths,
            int maxHosts,
            java.util.function.Function<String, List<Credential>> credentials) {
        this.rtspProbe = new RtspProbe(ffprobePath);
        this.rtspTransport = rtspTransport;
        this.maxHosts = maxHosts;
        this.credentials = credentials;
        this.pathGuesser = new RtspPathGuesser(rtspProbe, rtspPaths, rtspTransport);
    }

    /** Everything found in the most recent scan, with credentials stripped. */
    public List<DiscoveredCamera> redactedResults() {
        return lastScan.values().stream().map(DiscoveredCamera::redacted).toList();
    }

    /** The usable RTSP URL for a camera profile, or null. Agent-internal. */
    public String streamUrl(String cameraId, String profileToken) {
        DiscoveredCamera camera = lastScan.get(cameraId);
        if (camera == null) {
            return null;
        }
        DiscoveredCamera.DiscoveredProfile profile = camera.profiles.get(profileToken);
        return profile == null ? null : profile.rtspUrl;
    }

    /** One full sweep. Safe to run on a timer; takes tens of seconds on a busy LAN. */
    public List<DiscoveredCamera> scan() {
        Map<String, DiscoveredCamera> found = new LinkedHashMap<>();

        // Multicast first: it is fast, needs no credentials, and yields the
        // exact ONVIF service URL rather than a guess.
        for (Map.Entry<String, String> entry : WsDiscovery.probe().entrySet()) {
            DiscoveredCamera camera = new DiscoveredCamera();
            camera.ipAddress = entry.getKey();
            camera.onvifServiceUrl = entry.getValue();
            camera.lastSeen = System.currentTimeMillis();
            found.put(camera.ipAddress, camera);
        }

        // Then sweep for anything that ignored it.
        for (Map.Entry<String, PortScanner.OpenPorts> entry : PortScanner.scan(maxHosts).entrySet()) {
            PortScanner.OpenPorts open = entry.getValue();
            DiscoveredCamera camera = found.computeIfAbsent(entry.getKey(), host -> {
                DiscoveredCamera fresh = new DiscoveredCamera();
                fresh.ipAddress = host;
                fresh.lastSeen = System.currentTimeMillis();
                return fresh;
            });
            camera.onvifPorts = open.onvif();
            camera.rtspPorts = open.rtsp();
            if (camera.onvifServiceUrl == null && !open.onvif().isEmpty()) {
                // The conventional ONVIF path; confirmed or refuted by the call below.
                camera.onvifServiceUrl = "http://" + camera.ipAddress + ":" + open.onvif().get(0) + "/onvif/device_service";
            }
        }

        // The ARP cache is only populated for hosts we have just spoken to,
        // which is why this runs after the sweep rather than before it.
        Map<String, String> arp = MacResolver.arpTable();
        for (DiscoveredCamera camera : found.values()) {
            String mac = arp.get(camera.ipAddress);
            if (mac == null) {
                MacResolver.prime(camera.ipAddress);
                mac = MacResolver.arpTable().get(camera.ipAddress);
            }
            camera.macAddress = mac;
        }

        for (DiscoveredCamera camera : found.values()) {
            // Identity first, from whatever is already known, so that
            // per-camera credentials can be selected before authenticating.
            // Interrogation may then upgrade it once a serial number appears.
            assignIdentity(camera);
            interrogate(camera);
            assignIdentity(camera);
        }

        lastScan = found;
        long usable = found.values().stream()
                .filter(c -> c.authState == DiscoveredCamera.AuthState.AUTHENTICATED).count();
        log.info("discovery complete: {} device(s), {} usable", found.size(), usable);
        return redactedResults();
    }

    /**
     * Serial number, then MAC, then IP.
     *
     * Falling through to the IP is recorded rather than hidden: that identity
     * will not survive the next DHCP lease, and an operator approving such a
     * camera deserves to be told.
     */
    private static void assignIdentity(DiscoveredCamera camera) {
        if (camera.serialNumber != null && !camera.serialNumber.isBlank()) {
            camera.id = "sn-" + camera.serialNumber.trim().replaceAll("[^A-Za-z0-9._-]", "");
            camera.identityStable = true;
        } else if (camera.macAddress != null && !camera.macAddress.isBlank()) {
            camera.id = "mac-" + camera.macAddress.replace(":", "");
            camera.identityStable = true;
        } else {
            camera.id = "ip-" + camera.ipAddress.replace('.', '-');
            camera.identityStable = false;
        }
    }

    /** Tries each known credential until one authenticates. */
    private void interrogate(DiscoveredCamera camera) {
        if (camera.onvifServiceUrl == null) {
            guessStreams(camera);
            return;
        }

        // An anonymous attempt first: many cameras expose GetDeviceInformation
        // without auth, which yields the serial number — and therefore the
        // identity this camera's own credential is filed under.
        List<Credential> toTry = new ArrayList<>();
        toTry.add(new Credential("", ""));
        toTry.addAll(credentials.apply(camera.id));

        for (Credential credential : toTry) {
            try {
                onvif.fillDeviceInformation(camera, credential.username(), credential.password());
                if (credential.username().isEmpty()) {
                    // Identified, but an anonymous read does not prove we can
                    // stream. Re-resolve identity now that the serial is known,
                    // then retry with any credential filed against it.
                    camera.authState = DiscoveredCamera.AuthState.NEEDS_CREDENTIALS;
                    assignIdentity(camera);
                    for (Credential specific : credentials.apply(camera.id)) {
                        if (!toTry.contains(specific)) {
                            toTry.add(specific);
                        }
                    }
                    continue;
                }
                collectProfiles(camera, credential);
                camera.authState = DiscoveredCamera.AuthState.AUTHENTICATED;
                return;
            } catch (OnvifClient.AuthenticationFailed e) {
                camera.authState = DiscoveredCamera.AuthState.NEEDS_CREDENTIALS;
            } catch (Exception e) {
                log.debug("ONVIF interrogation of {} failed: {}", camera.ipAddress, e.toString());
                if (camera.authState == DiscoveredCamera.AuthState.UNKNOWN) {
                    camera.authState = DiscoveredCamera.AuthState.UNSUPPORTED;
                    camera.note = e.getMessage();
                }
            }
        }

        // ONVIF is present but did not yield streams — a very common state for
        // budget cameras. Fall back to probing known vendor paths.
        if (camera.profiles.isEmpty()) {
            guessStreams(camera);
        }
    }

    /** Last resort for cameras without a usable ONVIF media service. */
    private void guessStreams(DiscoveredCamera camera) {
        if (camera.rtspPorts.isEmpty()) {
            if (camera.authState == DiscoveredCamera.AuthState.UNKNOWN) {
                camera.authState = DiscoveredCamera.AuthState.UNSUPPORTED;
                camera.note = "no ONVIF service and no RTSP port open";
            }
            return;
        }
        Map<String, DiscoveredCamera.DiscoveredProfile> guessed =
                pathGuesser.guess(camera.ipAddress, camera.rtspPorts, credentials.apply(camera.id));
        if (guessed.isEmpty()) {
            camera.authState = DiscoveredCamera.AuthState.NEEDS_CREDENTIALS;
            camera.note = "RTSP port open but no known stream path responded";
            return;
        }
        camera.profiles.putAll(guessed);
        camera.authState = DiscoveredCamera.AuthState.AUTHENTICATED;
        camera.note = "streams found by probing known vendor paths";
    }

    private void collectProfiles(DiscoveredCamera camera, Credential credential) throws Exception {
        String mediaUrl = onvif.mediaServiceUrl(camera, credential.username(), credential.password());
        onvif.fillProfiles(camera, mediaUrl, credential.username(), credential.password());

        for (String token : List.copyOf(camera.profiles.keySet())) {
            try {
                onvif.fillStreamUri(camera, mediaUrl, token, credential.username(), credential.password());
            } catch (Exception e) {
                log.debug("GetStreamUri failed for {} profile {}: {}", camera.ipAddress, token, e.toString());
                continue;
            }
            DiscoveredCamera.DiscoveredProfile profile = camera.profiles.get(token);
            if (profile.rtspUrl == null) {
                continue;
            }
            profile.rtspUrl = withCredentials(profile.rtspUrl, credential);

            // ONVIF's declared encoding is often stale; the stream is authoritative.
            RtspProbe.Result actual = rtspProbe.probe(profile.rtspUrl, rtspTransport);
            if (actual != null) {
                if (actual.codec() != null && !actual.codec().equalsIgnoreCase(profile.codec)) {
                    log.info("camera {} profile {} reports {} but streams {}",
                            camera.ipAddress, token, profile.codec, actual.codec());
                    profile.codec = actual.codec();
                }
                if (actual.width() != null) profile.width = actual.width();
                if (actual.height() != null) profile.height = actual.height();
                if (actual.fps() != null) profile.fps = actual.fps();
            }
        }
    }

    /**
     * ONVIF returns a bare rtsp:// URL; ffmpeg needs the credentials inline.
     * This value stays on the agent — {@link DiscoveredCamera#redacted()} drops it.
     */
    private static String withCredentials(String rtspUrl, Credential credential) {
        if (credential.username() == null || credential.username().isEmpty()) {
            return rtspUrl;
        }
        try {
            URI uri = URI.create(rtspUrl);
            if (uri.getUserInfo() != null) {
                return rtspUrl;
            }
            String encodedUser = java.net.URLEncoder.encode(credential.username(), java.nio.charset.StandardCharsets.UTF_8);
            String encodedPass = java.net.URLEncoder.encode(credential.password(), java.nio.charset.StandardCharsets.UTF_8);
            return uri.getScheme() + "://" + encodedUser + ":" + encodedPass + "@"
                    + uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "")
                    + (uri.getRawPath() == null ? "" : uri.getRawPath())
                    + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        } catch (Exception e) {
            return rtspUrl;
        }
    }
}
