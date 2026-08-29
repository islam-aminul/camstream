package online.camstream.agent.discovery;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A camera the agent found on the local network, before an administrator has
 * decided anything about it.
 *
 * Everything here is safe to report to the cloud. Credentials deliberately are
 * not a field: they are supplied to the agent encrypted, used locally, and
 * never travel back up. {@link #authState} is how the admin UI learns whether
 * a credential is needed without ever seeing one.
 */
public final class DiscoveredCamera {

    public enum AuthState {
        /** Reachable, but nothing has been tried yet. */
        UNKNOWN,
        /** Responds, and rejected the credentials available. */
        NEEDS_CREDENTIALS,
        /** Credentials worked; stream URLs were retrieved. */
        AUTHENTICATED,
        /** Answered a port scan but not ONVIF or RTSP. Probably not a camera. */
        UNSUPPORTED
    }

    /**
     * Identity that survives a DHCP lease change.
     *
     * Preference order is deliberate: an ONVIF serial number is stable across
     * both address and NIC replacement; a MAC survives re-addressing; an IP
     * survives nothing. {@link #identityStable} says which was available, so
     * the admin UI can warn before an operator approves a camera whose identity
     * will move the next time the lease renews.
     */
    public String id;

    /** False when {@link #id} had to fall back to the IP address. */
    public boolean identityStable;

    public String ipAddress;
    public String macAddress;

    /**
     * Other identities this same camera would have been given.
     *
     * An approval recorded before the MAC could be read names one of these.
     * Matching on them means a camera keeps publishing across a change of
     * identity scheme rather than going dark until somebody notices.
     */
    public List<String> alternateIds = List.of();
    public String manufacturer;
    public String model;
    public String firmware;
    public String serialNumber;
    public String onvifServiceUrl;

    public List<Integer> onvifPorts = new ArrayList<>();
    public List<Integer> rtspPorts = new ArrayList<>();

    public AuthState authState = AuthState.UNKNOWN;
    public String note;

    /** Profile token -> stream description, in the order ONVIF reported them. */
    public Map<String, DiscoveredProfile> profiles = new LinkedHashMap<>();

    /** Millis since epoch when this camera was last seen responding. */
    public long lastSeen;

    /**
     * One ONVIF media profile.
     *
     * {@code rtspUrl} may embed credentials, so it is held only in memory on the
     * agent and stripped before anything is reported upward — see
     * {@link #redacted()}.
     */
    public static final class DiscoveredProfile {
        public String token;
        public String name;
        public String codec;
        /** H.264/HEVC profile as ffprobe names it, e.g. "High" or "High 10". */
        public String codecProfile;
        /** Level times ten, as ffprobe reports it: 40 means level 4.0. */
        public Integer codecLevel;
        public Integer width;
        public Integer height;
        public Integer fps;
        public Integer bitrateKbps;
        /** GOP length in frames, where the camera reports it. */
        public Integer gopFrames;
        public String rtspUrl;

        /** Rough guess at which CamStream profile this maps to. */
        public boolean looksLikeSubStream() {
            return height != null && height <= 720;
        }
    }

    /**
     * A full copy, RTSP URLs and all — for use inside the agent only.
     *
     * Distinct from {@link #redacted()} on purpose: that one exists to cross
     * the network and deliberately drops the stream URLs, because they carry
     * the password in their userinfo. This one is for splitting a recorder
     * into the cameras behind it, which needs those URLs to keep working.
     */
    public DiscoveredCamera copy() {
        DiscoveredCamera copy = redacted();
        copy.profiles.clear();
        for (Map.Entry<String, DiscoveredProfile> entry : profiles.entrySet()) {
            DiscoveredProfile source = entry.getValue();
            DiscoveredProfile full = new DiscoveredProfile();
            full.token = source.token;
            full.name = source.name;
            full.codec = source.codec;
            full.codecProfile = source.codecProfile;
            full.codecLevel = source.codecLevel;
            full.width = source.width;
            full.height = source.height;
            full.fps = source.fps;
            full.rtspUrl = source.rtspUrl;
            copy.profiles.put(entry.getKey(), full);
        }
        return copy;
    }

    /** A copy with every credential-bearing field removed, safe to send to the cloud. */
    public DiscoveredCamera redacted() {
        DiscoveredCamera copy = new DiscoveredCamera();
        copy.id = id;
        copy.identityStable = identityStable;
        copy.ipAddress = ipAddress;
        copy.macAddress = macAddress;
        copy.alternateIds = List.copyOf(alternateIds);
        copy.manufacturer = manufacturer;
        copy.model = model;
        copy.firmware = firmware;
        copy.serialNumber = serialNumber;
        copy.onvifServiceUrl = onvifServiceUrl;
        copy.onvifPorts = List.copyOf(onvifPorts);
        copy.rtspPorts = List.copyOf(rtspPorts);
        copy.authState = authState;
        copy.note = note;
        copy.lastSeen = lastSeen;
        for (Map.Entry<String, DiscoveredProfile> entry : profiles.entrySet()) {
            DiscoveredProfile source = entry.getValue();
            DiscoveredProfile safe = new DiscoveredProfile();
            safe.token = source.token;
            safe.name = source.name;
            safe.codec = source.codec;
            safe.codecProfile = source.codecProfile;
            safe.codecLevel = source.codecLevel;
            safe.width = source.width;
            safe.height = source.height;
            safe.fps = source.fps;
            safe.bitrateKbps = source.bitrateKbps;
            safe.gopFrames = source.gopFrames;
            // rtspUrl intentionally omitted — it can contain user:pass@.
            copy.profiles.put(entry.getKey(), safe);
        }
        return copy;
    }

    @Override
    public String toString() {
        return (manufacturer == null ? "camera" : manufacturer)
                + " " + (model == null ? "" : model)
                + " @ " + ipAddress + " [" + authState + "]";
    }
}
