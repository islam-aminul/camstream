package online.camstream.agent.control;

import java.util.Locale;

/**
 * Which codec a rendition is published in.
 *
 * A single camera can be publishing both at once: viewers whose browser decodes
 * the camera's native codec take {@link #SOURCE}, and only those that cannot
 * cause {@link #H264} to be produced. Nobody pays for encoding on behalf of
 * someone else's browser.
 */
public enum Variant {

    /** The camera's own codec, stream-copied. Always preferred. */
    SOURCE,

    /** Transcoded to H.264 for browsers that cannot decode the source. */
    H264;

    public String key() {
        return name().toLowerCase(Locale.ROOT);
    }

    public static Variant fromKey(String key) {
        if (key == null || key.isBlank()) {
            return SOURCE;
        }
        return switch (key.trim().toLowerCase(Locale.ROOT)) {
            case "source", "native", "copy" -> SOURCE;
            case "h264", "avc" -> H264;
            default -> throw new IllegalArgumentException("unknown variant: " + key);
        };
    }
}
