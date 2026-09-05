package online.camstream.agent.discovery;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Finds streams on cameras that have no usable ONVIF service.
 *
 * A large share of installed CCTV either omits ONVIF, ships it disabled, or
 * implements it badly enough that GetStreamUri fails. Those cameras still serve
 * RTSP on a well-known vendor path, so the remaining option is to try the paths
 * and see which ones decode.
 *
 * Every candidate is confirmed with ffprobe rather than by the server's
 * response code: plenty of devices answer DESCRIBE with 200 on a path that
 * carries no media.
 */
final class RtspPathGuesser {

    private static final Logger log = LoggerFactory.getLogger(RtspPathGuesser.class);

    /**
     * Ordered most-likely-first, main stream before sub stream within a vendor,
     * so the first hit for a camera is usually its primary rendition.
     */
    static final List<String> DEFAULT_PATHS = List.of(
            // Hikvision, and the many OEMs that clone its firmware
            "/Streaming/Channels/101", "/Streaming/Channels/102",
            // Dahua and clones
            "/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1",
            // Axis
            "/axis-media/media.amp",
            // Reolink
            "/h264Preview_01_main", "/h264Preview_01_sub",
            // Uniview
            "/media/video1", "/media/video2",
            // Amcrest, Foscam and generic ONVIF-ish firmware
            "/live", "/live.sdp", "/live/ch0", "/live/ch1",
            "/h264", "/h264_stream", "/stream1", "/stream2",
            "/video1", "/video.mp4", "/11", "/12",
            "/onvif1", "/onvif2",
            // Bare root: some cheap modules serve the only stream there
            "/");

    /**
     * The smallest frame that could be a real rendition.
     *
     * A recorder here reported its main stream as 44x32. Nothing refused it, so
     * it became a profile - and because main and sub are chosen by picking the
     * largest and smallest, a nonsense 44x32 won "smallest" and took the sub
     * role. The sub is what the wall pulls, so every tile on that recorder was
     * served the full-resolution stream instead: measured at 1.8 MB per segment
     * against 52 KB from a camera whose sub was real, on the same wall.
     *
     * Nothing looked broken. The video played, the console showed six cameras
     * publishing, and the only visible symptom was the bill.
     *
     * 160x120 is below any rendition a camera is configured to serve and well
     * above a misparse, so it separates the two without needing to know what
     * the device meant.
     */
    static final int SMALLEST_REAL_WIDTH = 160;
    static final int SMALLEST_REAL_HEIGHT = 120;

    /** Whether a probe result describes a rendition worth offering. */
    static boolean isPlausibleRendition(Integer width, Integer height) {
        // Unknown dimensions are not a reason to refuse: some firmware reports
        // nothing useful and still streams perfectly. Only a stated, and
        // impossibly small, size is refused.
        if (width == null || height == null) {
            return true;
        }
        return width >= SMALLEST_REAL_WIDTH && height >= SMALLEST_REAL_HEIGHT;
    }

    private final RtspProbe probe;
    private final List<String> paths;
    private final String transport;

    RtspPathGuesser(RtspProbe probe, List<String> paths, String transport) {
        this.probe = probe;
        this.paths = paths == null || paths.isEmpty() ? DEFAULT_PATHS : paths;
        this.transport = transport;
    }

    /**
     * Tries the known paths, moving to the next credential only when the camera
     * refused the one before it.
     *
     * The distinction is the whole point. A camera that answers 401 has the
     * path and dislikes the password, so another password is worth trying. A
     * camera that answers "no such path" will answer that to every password
     * there is, and marching a site's whole credential list past it multiplies
     * the scan by five for nothing - on devices that often lock an account out
     * after a handful of failures.
     *
     * @return profiles keyed by a synthetic token, empty if nothing decoded
     */
    Map<String, DiscoveredCamera.DiscoveredProfile> guess(
            String host, List<Integer> rtspPorts, List<Credential> credentials) {
        return guess(host, rtspPorts, credentials, null);
    }

    /**
     * The same, with the manufacturer known.
     *
     * A vendor's own paths go first. The generic list is two dozen entries and
     * every miss is a timeout, so knowing the maker turns a walk through all of
     * them into a walk through four - and the ones tried first are the ones
     * this device actually serves.
     */
    Map<String, DiscoveredCamera.DiscoveredProfile> guess(
            String host, List<Integer> rtspPorts, List<Credential> credentials,
            VendorDirectory.Vendor vendor) {

        List<Credential> toTry = new ArrayList<>(credentials);
        // Some cameras stream without authentication even when ONVIF requires it.
        toTry.add(new Credential("", ""));

        List<String> ordered = orderFor(vendor);
        for (int port : rtspPorts) {
            for (Credential credential : toTry) {
                Attempt attempt = tryPaths(host, port, credential, ordered);
                if (!attempt.found().isEmpty()) {
                    log.info("guessed {} stream(s) on {}:{} as \"{}\"",
                            attempt.found().size(), host, port,
                            credential.username().isEmpty() ? "<anonymous>" : credential.username());
                    return attempt.found();
                }
                if (!attempt.refused()) {
                    // Nothing here refused us; it simply has none of these
                    // paths. A different password cannot conjure one.
                    break;
                }
            }
        }
        return Map.of();
    }

    /** What one credential achieved against one port, and whether it was refused. */
    private record Attempt(Map<String, DiscoveredCamera.DiscoveredProfile> found, boolean refused) {}

    /** This vendor's paths first, then the rest, with no path tried twice. */
    private List<String> orderFor(VendorDirectory.Vendor vendor) {
        if (vendor == null || vendor.paths().isEmpty()) {
            return paths;
        }
        List<String> ordered = new ArrayList<>(vendor.paths());
        for (String path : paths) {
            if (!ordered.contains(path)) {
                ordered.add(path);
            }
        }
        return ordered;
    }

    private Attempt tryPaths(String host, int port, Credential credential, List<String> candidates) {
        Map<String, DiscoveredCamera.DiscoveredProfile> found = new LinkedHashMap<>();
        boolean refused = false;
        for (String path : candidates) {
            String url = buildUrl(host, port, path, credential);
            RtspProbe.Outcome outcome = probe.attempt(url, transport);
            if (outcome.unauthorized()) {
                refused = true;
            }
            RtspProbe.Result result = outcome.stream();
            if (result == null || result.codec() == null) {
                continue;
            }
            if (!isPlausibleRendition(result.width(), result.height())) {
                log.info("ignoring {} on {}: {}x{} is not a real rendition",
                        path, host, result.width(), result.height());
                continue;
            }
            DiscoveredCamera.DiscoveredProfile profile = new DiscoveredCamera.DiscoveredProfile();
            profile.token = "guessed" + (found.size() + 1);
            profile.name = path;
            profile.codec = result.codec();
            profile.width = result.width();
            profile.height = result.height();
            profile.fps = result.fps();
            profile.rtspUrl = url;
            found.put(profile.token, profile);

            // Two renditions is what CamStream models; more would be noise.
            if (found.size() >= 2) {
                break;
            }
        }
        return new Attempt(found, refused);
    }

    private static String buildUrl(String host, int port, String path, Credential credential) {
        StringBuilder url = new StringBuilder("rtsp://");
        if (credential.username() != null && !credential.username().isEmpty()) {
            url.append(encode(credential.username())).append(':')
               .append(encode(credential.password())).append('@');
        }
        url.append(host);
        if (port != 554) {
            url.append(':').append(port);
        }
        url.append(path.startsWith("/") ? path : "/" + path);
        return url.toString();
    }

    private static String encode(String value) {
        return java.net.URLEncoder.encode(value == null ? "" : value, java.nio.charset.StandardCharsets.UTF_8);
    }

    /**
     * Walks a recorder's channels and returns the streams behind each one.
     *
     * Only attempted for a vendor whose numbering scheme is known: without one
     * the paths would be invented and every probe a timeout. The walk stops
     * after a run of empty channels rather than at the ceiling, because a
     * recorder with an unused bay in the middle still has cameras after it.
     *
     * @return one entry per live channel, keyed by channel number
     */
    Map<Integer, Map<String, DiscoveredCamera.DiscoveredProfile>> walkChannels(
            String host, int port, Credential credential, VendorDirectory.Vendor vendor) {

        Map<Integer, Map<String, DiscoveredCamera.DiscoveredProfile>> byChannel =
                new LinkedHashMap<>();
        if (vendor == null || !vendor.enumeratesChannels()) {
            return byChannel;
        }

        ChannelWalk walk = new ChannelWalk();
        while (walk.hasNext()) {
            int channel = walk.next();
            Map<String, DiscoveredCamera.DiscoveredProfile> profiles = new LinkedHashMap<>();

            addChannelProfile(profiles, host, port, credential,
                    VendorDirectory.resolveChannel(vendor.nvrMainPattern(), channel), "main");
            addChannelProfile(profiles, host, port, credential,
                    VendorDirectory.resolveChannel(vendor.nvrSubPattern(), channel), "sub");

            if (profiles.isEmpty()) {
                walk.empty();
            } else {
                walk.found();
                byChannel.put(channel, profiles);
            }
        }

        if (!byChannel.isEmpty()) {
            log.info("{} looks like a recorder: {} channel(s) with streams, stopped at {}",
                    host, walk.channelsFound(), walk.lastChannel());
        }
        return byChannel;
    }

    private void addChannelProfile(
            Map<String, DiscoveredCamera.DiscoveredProfile> into,
            String host, int port, Credential credential, String path, String name) {

        if (path == null || path.isBlank()) {
            return;
        }
        String url = buildUrl(host, port, path, credential);
        RtspProbe.Result result = probe.attempt(url, transport).stream();
        if (result == null || result.codec() == null) {
            return;
        }
        if (!isPlausibleRendition(result.width(), result.height())) {
            log.info("ignoring channel path {} on {}: {}x{} is not a real rendition",
                    path, host, result.width(), result.height());
            return;
        }
        DiscoveredCamera.DiscoveredProfile profile = new DiscoveredCamera.DiscoveredProfile();
        profile.token = name;
        profile.name = name;
        profile.codec = result.codec();
        profile.width = result.width();
        profile.height = result.height();
        profile.fps = result.fps();
        profile.rtspUrl = url;
        into.put(profile.token, profile);
    }
}
