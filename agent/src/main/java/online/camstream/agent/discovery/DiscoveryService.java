package online.camstream.agent.discovery;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Finds cameras on the local network and works out how to stream from them.
 *
 * Runs entirely on-premises. Credentials are tried here and the resulting RTSP
 * URLs — which embed those credentials — stay here; only redacted metadata is
 * ever handed to the caller for reporting upward.
 */
public final class DiscoveryService implements CameraSource {

    private static final Logger log = LoggerFactory.getLogger(DiscoveryService.class);

    private final OnvifClient onvif = new OnvifClient();
    private final RtspProbe rtspProbe;
    private final RtspPathGuesser pathGuesser;
    /** Credentials to try for a given camera identity, most specific first. */
    private final java.util.function.Function<String, List<Credential>> credentials;
    private final String rtspTransport;
    private final int maxHosts;
    private final List<String> extraNetworks;

    /** Last full result, including credential-bearing URLs. Never leaves the agent. */
    private volatile Map<String, DiscoveredCamera> lastScan = Map.of();

    public DiscoveryService(
            String ffprobePath,
            String rtspTransport,
            List<String> rtspPaths,
            int maxHosts,
            List<String> extraNetworks,
            java.util.function.Function<String, List<Credential>> credentials) {
        this.rtspProbe = new RtspProbe(ffprobePath);
        this.rtspTransport = rtspTransport;
        this.maxHosts = maxHosts;
        this.extraNetworks = extraNetworks == null ? List.of() : List.copyOf(extraNetworks);
        this.credentials = credentials;
        this.pathGuesser = new RtspPathGuesser(rtspProbe, rtspPaths, rtspTransport);
    }

    /** Everything found in the most recent scan, with credentials stripped. */
    @Override
    public List<DiscoveredCamera> redactedResults() {
        return lastScan.values().stream().map(DiscoveredCamera::redacted).toList();
    }

    @Override
    public StreamFacts probeStream(String rtspUrl, String transport) {
        RtspProbe.Result result = rtspProbe.probe(
                rtspUrl, transport == null || transport.isBlank() ? rtspTransport : transport);
        if (result == null) {
            return null;
        }
        return new StreamFacts(
                result.codec(), result.profile(), result.level(), result.width(), result.height());
    }

    /** The usable RTSP URL for a camera profile, or null. Agent-internal. */
    @Override
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
        for (Map.Entry<String, PortScanner.OpenPorts> entry : PortScanner.scan(maxHosts, extraNetworks).entrySet()) {
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

        // A MAC seen at more than one address is not a camera's MAC. ARP only
        // holds on-link entries, so this normally cannot happen — but proxy ARP
        // and some consumer routers answer for hosts behind them, and every
        // camera on the far side then reports the router's address. Left alone
        // that would fold a dozen cameras into one identity, so the value is
        // dropped and identity falls through to the serial.
        discardSharedMacs(found.values());

        for (DiscoveredCamera camera : found.values()) {
            // Identity first, from whatever is already known, so that
            // per-camera credentials can be selected before authenticating.
            // Interrogation may then upgrade it once a serial number appears.
            assignIdentity(camera);
            interrogate(camera);
            assignIdentity(camera);
        }

        // Again, because interrogation can have introduced addresses ARP never
        // saw. Cloned firmware shipping one address across a production run is
        // rarer than proxy ARP but no less fatal to an identity.
        discardSharedMacs(found.values());
        for (DiscoveredCamera camera : found.values()) {
            assignIdentity(camera);
        }

        // Re-key by identity. The sweep collects by IP address because that is
        // all it knows at the time, but every consumer looks a camera up by the
        // identity assigned afterwards — an approved camera resolved to nothing
        // while these disagreed.
        Map<String, DiscoveredCamera> byIdentity = new LinkedHashMap<>();
        for (DiscoveredCamera camera : found.values()) {
            byIdentity.put(camera.id, camera);
        }
        lastScan = byIdentity;

        long usable = found.values().stream()
                .filter(c -> c.authState == DiscoveredCamera.AuthState.AUTHENTICATED).count();
        log.info("discovery complete: {} device(s), {} usable", found.size(), usable);
        return redactedResults();
    }

    /**
     * MAC address, then serial number, then IP.
     *
     * The MAC leads because it is the only one of the three the camera cannot
     * get wrong. It is assigned by the manufacturer, unique by construction,
     * and read off the network rather than out of the firmware — so it is
     * there even when ONVIF refuses to authenticate, and it survives a factory
     * reset that clears everything else. Serial numbers come from the firmware,
     * and budget OEM cameras routinely report a blank one, a shared one, or the
     * model name.
     *
     * Falling through to the IP is recorded rather than hidden: that identity
     * will not survive the next DHCP lease, and an operator approving such a
     * camera deserves to be told.
     */
    private static void assignIdentity(DiscoveredCamera camera) {
        String mac = macIdentity(camera);
        String serial = serialIdentity(camera);
        String ip = "ip-" + camera.ipAddress.replace('.', '-');

        if (mac != null) {
            camera.id = mac;
            camera.identityStable = true;
        } else if (serial != null) {
            camera.id = serial;
            camera.identityStable = true;
        } else {
            camera.id = ip;
            camera.identityStable = false;
        }

        // Everything this camera would also have been called. An approval made
        // before the MAC was readable — or before this ordering changed — names
        // one of these, and matching on them keeps that camera publishing
        // instead of silently going dark until somebody re-approves it.
        camera.alternateIds = Stream.of(mac, serial, ip)
                .filter(Objects::nonNull)
                .filter(id -> !id.equals(camera.id))
                .toList();
    }

    /**
     * Drops any hardware address claimed by more than one device.
     *
     * Whatever the source, an address two devices share cannot identify either
     * of them — so it is discarded and identity falls through to the serial.
     */
    private static void discardSharedMacs(Collection<DiscoveredCamera> cameras) {
        Map<String, Long> perMac = cameras.stream()
                .map(camera -> camera.macAddress)
                .filter(Objects::nonNull)
                .collect(Collectors.groupingBy(mac -> mac, Collectors.counting()));
        for (DiscoveredCamera camera : cameras) {
            if (camera.macAddress != null && perMac.getOrDefault(camera.macAddress, 0L) > 1) {
                log.warn("{} devices report hardware address {} — it cannot identify any of them",
                        perMac.get(camera.macAddress), camera.macAddress);
                camera.macAddress = null;
            }
        }
    }

    private static String macIdentity(DiscoveredCamera camera) {
        if (camera.macAddress == null || camera.macAddress.isBlank()) {
            return null;
        }
        return "mac-" + camera.macAddress.replace(":", "").toLowerCase(java.util.Locale.ROOT);
    }

    private static String serialIdentity(DiscoveredCamera camera) {
        if (camera.serialNumber == null || camera.serialNumber.isBlank()) {
            return null;
        }
        return "sn-" + camera.serialNumber.trim().replaceAll("[^A-Za-z0-9._-]", "");
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
                // Ask the camera for its own MAC where ARP could not supply
                // one. ARP only sees the local segment, so a camera a routed
                // hop away — most of them, on a site of any size — would
                // otherwise fall back to identifying by serial number.
                if (camera.macAddress == null || camera.macAddress.isBlank()) {
                    String mac = onvif.hardwareAddress(camera, credential.username(), credential.password());
                    if (mac != null) {
                        log.info("camera at {} reported its hardware address over ONVIF: {}",
                                camera.ipAddress, mac);
                        camera.macAddress = mac;
                    }
                }
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
                if (actual.profile() != null) profile.codecProfile = actual.profile();
                if (actual.level() != null) profile.codecLevel = actual.level();
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
    static String withCredentials(String rtspUrl, Credential credential) {
        if (credential.username() == null || credential.username().isEmpty()) {
            return rtspUrl;
        }
        try {
            URI uri = URI.create(rtspUrl);
            if (uri.getUserInfo() != null) {
                return rtspUrl;
            }
            String encodedUser = percentEncode(credential.username());
            String encodedPass = percentEncode(credential.password());
            return uri.getScheme() + "://" + encodedUser + ":" + encodedPass + "@"
                    + uri.getHost() + (uri.getPort() > 0 ? ":" + uri.getPort() : "")
                    + (uri.getRawPath() == null ? "" : uri.getRawPath())
                    + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        } catch (Exception e) {
            return rtspUrl;
        }
    }

    /**
     * Percent-encodes one userinfo component, per RFC 3986.
     *
     * Not URLEncoder, which this used to be. URLEncoder implements HTML form
     * encoding, and its defining difference is that a space becomes '+' rather
     * than %20 — so a password with a space in it reached the camera as a
     * different password, and one containing '+' arrived as a space. The
     * camera answered 401, which the agent reads as a refusal and backs off
     * from for five minutes with "check the credentials". The credentials were
     * correct; this was not.
     *
     * Everything outside the unreserved set is escaped. That is stricter than
     * userinfo strictly requires, which costs nothing: a percent-encoded
     * unreserved character is equivalent to the character itself, so
     * over-escaping is always safe and under-escaping is not.
     */
    private static String percentEncode(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (byte raw : value.getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
            int c = raw & 0xFF;
            boolean unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '.' || c == '_' || c == '~';
            if (unreserved) {
                out.append((char) c);
            } else {
                out.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16)))
                        .append(Character.toUpperCase(Character.forDigit(c & 0x0F, 16)));
            }
        }
        return out.toString();
    }
}
