package online.camstream.agent.discovery;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

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
    private final Supplier<List<Credential>> credentials;
    private final String rtspTransport;

    /** Last full result, including credential-bearing URLs. Never leaves the agent. */
    private volatile Map<String, DiscoveredCamera> lastScan = Map.of();

    public DiscoveryService(String ffprobePath, String rtspTransport, Supplier<List<Credential>> credentials) {
        this.rtspProbe = new RtspProbe(ffprobePath);
        this.rtspTransport = rtspTransport;
        this.credentials = credentials;
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
        for (Map.Entry<String, PortScanner.OpenPorts> entry : PortScanner.scan().entrySet()) {
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

        for (DiscoveredCamera camera : found.values()) {
            camera.id = camera.macAddress != null ? camera.macAddress : camera.ipAddress;
            interrogate(camera);
        }

        lastScan = found;
        long usable = found.values().stream()
                .filter(c -> c.authState == DiscoveredCamera.AuthState.AUTHENTICATED).count();
        log.info("discovery complete: {} device(s), {} usable", found.size(), usable);
        return redactedResults();
    }

    /** Tries each known credential until one authenticates. */
    private void interrogate(DiscoveredCamera camera) {
        if (camera.onvifServiceUrl == null) {
            camera.authState = camera.rtspPorts.isEmpty()
                    ? DiscoveredCamera.AuthState.UNSUPPORTED
                    : DiscoveredCamera.AuthState.NEEDS_CREDENTIALS;
            camera.note = "RTSP port open but no ONVIF service found";
            return;
        }

        List<Credential> toTry = new ArrayList<>(credentials.get());
        // An anonymous attempt first: some cameras expose GetDeviceInformation
        // without auth, which identifies the device even when the operator has
        // not supplied a credential yet.
        toTry.add(0, new Credential("", ""));

        for (Credential credential : toTry) {
            try {
                onvif.fillDeviceInformation(camera, credential.username(), credential.password());
                if (credential.username().isEmpty()) {
                    // Identified, but an anonymous read does not prove we can stream.
                    camera.authState = DiscoveredCamera.AuthState.NEEDS_CREDENTIALS;
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
