package online.camstream.agent.control;

import online.camstream.agent.config.StreamProfile;

/** One camera at one quality — the unit an agent starts and stops. */
public record Rendition(String cameraId, StreamProfile profile) {

    /** Path segment beneath the device prefix: {@code <cameraId>/<profile>/}. */
    public String keySuffix() {
        return cameraId + "/" + profile.key() + "/";
    }

    @Override
    public String toString() {
        return cameraId + "/" + profile.key();
    }
}
