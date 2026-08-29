package online.camstream.agent.update;

/**
 * Whether an update is worth taking, and what has to be true before it is.
 *
 * Separated from the downloading and the file shuffling because this is the
 * part that must not be wrong. An agent that replaces its own program has no
 * second chance: if the new jar does not start, nothing is left running to
 * notice or to put the old one back, and the site is dark until somebody
 * drives to it.
 *
 * So the rules are conservative, and they are here where they can be read and
 * tested without downloading anything.
 */
public final class SelfUpdate {

    /**
     * The exit code the agent uses to ask its service manager for a restart.
     *
     * Non-zero on purpose. systemd restarts on any exit under Restart=always,
     * but WinSW restarts on failure, and a clean zero would stop the service
     * and leave the machine with a freshly installed agent that is not running.
     */
    public static final int RESTART_EXIT_CODE = 7;

    /** Smallest plausible bundle; anything less is a truncated download. */
    static final long MIN_BYTES = 256 * 1024;

    public enum Decision {
        /** Take it. */
        UPDATE,
        /** Already running this version. */
        ALREADY_CURRENT,
        /** The instruction did not say what to install, or where from. */
        MALFORMED,
        /** The version named is not one this agent will accept. */
        REFUSED
    }

    private SelfUpdate() {
    }

    /**
     * Decides whether to act on an update instruction.
     *
     * The version is compared as a string rather than ordered: this is a
     * command from the console naming an exact build, not a search for the
     * newest. Downgrades are therefore allowed, deliberately - rolling a site
     * back to a known-good agent is the thing you most want to be able to do
     * remotely, and refusing it would mean the one situation where remote
     * update matters most is the one it cannot help with.
     */
    public static Decision decide(String runningVersion, String wantedVersion, String url) {
        if (wantedVersion == null || wantedVersion.isBlank() || url == null || url.isBlank()) {
            return Decision.MALFORMED;
        }
        if (!isPlausibleVersion(wantedVersion)) {
            return Decision.REFUSED;
        }
        if (!isTrustedSource(url)) {
            return Decision.REFUSED;
        }
        if (wantedVersion.equals(runningVersion)) {
            return Decision.ALREADY_CURRENT;
        }
        return Decision.UPDATE;
    }

    /** Digits, dots and a short qualifier - not a path, and not a shell. */
    static boolean isPlausibleVersion(String version) {
        return version.matches("[0-9]+(\\.[0-9]+){0,3}(-[A-Za-z0-9.]{1,20})?");
    }

    /**
     * Where a bundle may come from.
     *
     * The URL arrives over MQTT on a topic only this agent's certificate may
     * be published to, so it is already authenticated - but an instruction is
     * still an instruction, and pointing an agent at an arbitrary host is
     * exactly the shape of an attack worth being unable to perform. It must be
     * HTTPS, and it must be S3.
     */
    static boolean isTrustedSource(String url) {
        if (!url.startsWith("https://")) {
            return false;
        }
        int hostStart = "https://".length();
        int hostEnd = url.indexOf('/', hostStart);
        String host = (hostEnd < 0 ? url.substring(hostStart) : url.substring(hostStart, hostEnd))
                .toLowerCase();
        int port = host.indexOf(':');
        if (port >= 0) {
            host = host.substring(0, port);
        }
        return host.endsWith(".amazonaws.com") && host.contains("s3");
    }

    /** Whether a downloaded file is large enough to be a bundle at all. */
    public static boolean isPlausibleSize(long bytes) {
        return bytes >= MIN_BYTES;
    }
}
