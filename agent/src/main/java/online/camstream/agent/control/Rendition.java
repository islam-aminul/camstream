package online.camstream.agent.control;

import online.camstream.agent.config.StreamProfile;

/** One camera, at one quality, in one codec — the unit an agent starts and stops. */
public record Rendition(String cameraId, StreamProfile profile, Variant variant) {

    public Rendition {
        if (cameraId == null || cameraId.isBlank()) {
            throw new IllegalArgumentException("cameraId is required");
        }
        if (profile == null || variant == null) {
            throw new IllegalArgumentException("profile and variant are required");
        }
    }

    /**
     * Path segment beneath the device prefix.
     *
     * The source variant keeps the bare `<camera>/<profile>/` path so that
     * existing player URLs are unchanged; only transcoded output gets a suffix.
     */
    public String keySuffix() {
        return variant == Variant.SOURCE
                ? cameraId + "/" + profile.key() + "/"
                : cameraId + "/" + profile.key() + "-" + variant.key() + "/";
    }

    @Override
    public String toString() {
        return variant == Variant.SOURCE
                ? cameraId + "/" + profile.key()
                : cameraId + "/" + profile.key() + "-" + variant.key();
    }
}
