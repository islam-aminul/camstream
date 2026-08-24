package online.camstream.agent.config;

/** Which rendition of a camera is being published. */
public enum StreamProfile {
    /** Low-resolution, always the grid view. */
    SUB,
    /** Full-resolution, one camera at a time per viewer. */
    MAIN;

    /** Path segment used in S3 keys and playlist URLs. */
    public String key() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }

    public static StreamProfile fromKey(String key) {
        if (key == null) {
            return SUB;
        }
        return switch (key.toLowerCase(java.util.Locale.ROOT)) {
            case "main" -> MAIN;
            case "sub" -> SUB;
            default -> throw new IllegalArgumentException("unknown stream profile: " + key);
        };
    }
}
