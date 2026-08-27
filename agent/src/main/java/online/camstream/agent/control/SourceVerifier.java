package online.camstream.agent.control;

import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.discovery.CameraSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Checks that a configured camera streams what its configuration claims.
 *
 * Discovered cameras have always been probed, because ONVIF's declared
 * encoding is routinely stale. Cameras written into agent.yaml were taken at
 * their word, which is the weaker case rather than the stronger one: the
 * person writing that file is copying what the camera's own web UI says, and a
 * camera set to H.264 High 10 describes itself as "H.264" there. The agent
 * then advertises a stream browsers reject and treats a transcode request as
 * already satisfied.
 *
 * So the stream is asked directly. The cost is one ffprobe per camera, cached
 * per URL, which is why this runs on its own slow schedule rather than on
 * every refresh — a camera's encoder settings change when somebody changes
 * them, not continuously.
 */
public final class SourceVerifier {

    private static final Logger log = LoggerFactory.getLogger(SourceVerifier.class);

    private final CameraSource source;
    private final CameraRegistry registry;

    /** URL -> what it was found to carry, so a re-check costs nothing. */
    private final Map<String, CameraSource.StreamFacts> seen = new ConcurrentHashMap<>();
    /** URLs that could not be opened, so an offline camera is retried but not spammed. */
    private final Set<String> unreachable = ConcurrentHashMap.newKeySet();

    public SourceVerifier(CameraSource source, CameraRegistry registry) {
        this.source = source;
        this.registry = registry;
    }

    /**
     * Probes any configured camera not yet confirmed.
     *
     * @return true if the control plane's view of a camera is now stale
     */
    public boolean verify() {
        boolean changed = false;
        Set<String> stillUnreachable = new HashSet<>();

        for (CameraConfig camera : registry.all()) {
            // A camera resolved from discovery has already been probed against
            // the live stream; re-running that here would double the cost for
            // no new information.
            if (!camera.locallyConfigured) {
                continue;
            }
            if (verifyOne(camera, stillUnreachable)) {
                changed = true;
            }
        }

        unreachable.retainAll(stillUnreachable);
        unreachable.addAll(stillUnreachable);
        return changed;
    }

    private boolean verifyOne(CameraConfig camera, Set<String> stillUnreachable) {
        // Both renditions are probed. They usually match, but a camera can be
        // set to different profiles per stream, and a viewer meets whichever
        // one is unplayable — the grid uses sub and the detail view uses main.
        CameraSource.StreamFacts main = probe(camera, StreamProfile.MAIN, stillUnreachable);
        CameraSource.StreamFacts sub = probe(camera, StreamProfile.SUB, stillUnreachable);

        CameraSource.StreamFacts authoritative = choose(main, sub);
        if (authoritative == null || authoritative.codec() == null) {
            return false;
        }

        // Only codec and profile travel upward, so only those make a report
        // worth sending. The level matters locally — it goes into the master
        // playlist's CODECS attribute — but the agent republishes that itself.
        boolean reportable = false;
        if (!authoritative.codec().equalsIgnoreCase(String.valueOf(camera.sourceCodec))) {
            log.info("camera {} is configured as {} but streams {}",
                    camera.id, camera.sourceCodec, authoritative.codec());
            camera.sourceCodec = authoritative.codec();
            reportable = true;
        }
        if (authoritative.profile() != null
                && !authoritative.profile().equalsIgnoreCase(String.valueOf(camera.sourceCodecProfile))) {
            log.info("camera {} is configured as {} profile but streams {}",
                    camera.id, camera.sourceCodecProfile, authoritative.profile());
            camera.sourceCodecProfile = authoritative.profile();
            reportable = true;
        }
        if (authoritative.level() != null && !authoritative.level().equals(camera.sourceCodecLevel)) {
            camera.sourceCodecLevel = authoritative.level();
        }

        if (reportable && !camera.browserPlayable()) {
            log.warn("camera {} emits {} {} — no browser decodes this, so viewers will be offered "
                            + "a transcode; set the camera to 8-bit H.264 to avoid the CPU cost",
                    camera.id, camera.sourceCodec, camera.sourceCodecProfile);
        }
        return reportable;
    }

    private CameraSource.StreamFacts probe(
            CameraConfig camera, StreamProfile profile, Set<String> stillUnreachable) {
        String url = camera.urlFor(profile);
        if (url == null || url.isBlank()) {
            return null;
        }
        CameraSource.StreamFacts cached = seen.get(url);
        if (cached != null) {
            return cached;
        }

        CameraSource.StreamFacts facts = source.probeStream(url, camera.rtspTransport);
        if (facts == null) {
            // Offline cameras are ordinary. Log the first failure only, so a
            // camera that is down overnight does not fill the log.
            if (unreachable.add(url)) {
                log.info("could not probe {} {} stream — will retry", camera.id, profile.key());
            }
            stillUnreachable.add(url);
            return null;
        }
        seen.put(url, facts);
        return facts;
    }

    /**
     * Which probe result describes the camera.
     *
     * Main normally, because it is the larger stream and the one the detail
     * view uses. But if either rendition is something a browser cannot decode,
     * that is the fact worth carrying: offering a transcode that turns out to
     * be unnecessary costs some edge CPU, while missing one leaves a viewer
     * watching a stream that will never appear.
     */
    static CameraSource.StreamFacts choose(CameraSource.StreamFacts main, CameraSource.StreamFacts sub) {
        if (main == null) {
            return sub;
        }
        if (sub == null) {
            return main;
        }
        if (!CameraConfig.playableInBrowser(main.codec(), main.profile())) {
            return main;
        }
        if (!CameraConfig.playableInBrowser(sub.codec(), sub.profile())) {
            return sub;
        }
        return main;
    }
}
