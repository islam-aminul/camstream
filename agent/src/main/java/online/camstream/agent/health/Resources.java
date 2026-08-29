package online.camstream.agent.health;

/**
 * What the machine an agent runs on has left, and what that means for how much
 * it should be asked to do.
 *
 * The stream ceiling of 128 is a hard limit and not the real one. What an agent
 * can actually sustain is decided by its processor, its memory, the disk it
 * writes segments to and the uplink it sends them over, and it will reach one
 * of those long before it reaches 128. An operator who is told "128 maximum"
 * and then watches video stutter at 30 has been told nothing useful.
 *
 * So the agent measures those four, decides which one is binding, and says so
 * in words the person reading the console can act on. The judgement lives here,
 * away from the sampling, because it is the part worth testing: sampling a real
 * processor in a unit test measures the build machine.
 */
public final class Resources {

    private Resources() {
    }

    /** The resource that is running out, if one is. */
    public enum Constraint {
        NONE, CPU, MEMORY, DISK, UPLINK
    }

    /**
     * A sample of the machine. Any field may be -1, meaning the platform would
     * not say — an unknown value must never be read as a healthy one.
     */
    public record Snapshot(
            double cpuLoad,
            double memoryUsedFraction,
            long memoryFreeBytes,
            long diskFreeBytes,
            /** Throughput actually achieved uploading segments. */
            long uploadBytesPerSecond,
            /** How long a segment takes to upload, averaged over recent ones. */
            long uploadMillisPerSegment,
            /** Uploads that failed outright since the last report. */
            int uploadFailures) {

        public static Snapshot unknown() {
            return new Snapshot(-1, -1, -1, -1, -1, -1, 0);
        }
    }

    /**
     * What to do about it: which resource is binding, what to tell the
     * operator, and how many conversions the agent should be running.
     */
    public record Verdict(Constraint constraint, String message, int maxConcurrentTranscodes) {
        public boolean healthy() {
            return constraint == Constraint.NONE;
        }
    }

    /** Below this the disk cannot be trusted to hold a segment window. */
    static final long DISK_FLOOR_BYTES = 512L * 1024 * 1024;

    /** Above this the machine is spending its time swapping rather than encoding. */
    static final double MEMORY_CEILING = 0.92;

    static final double CPU_CEILING = 0.90;

    /**
     * Decides what the agent should be doing, given what it has left.
     *
     * Conversions are the discretionary cost: a passed-through stream is a copy
     * and costs almost nothing, while an H.264 conversion is a full encode. So
     * pressure sheds conversions first and leaves the passthrough streams
     * running, which is the choice that keeps the most cameras on screen.
     *
     * The cap steps down by one at a time rather than to zero, so an agent that
     * is merely busy loses one conversion and not the wall. Under sustained
     * pressure the step repeats and it converges on what the machine can hold.
     *
     * @param configuredCap  what the agent was told it may run
     * @param runningTranscodes how many it is running now
     * @param segmentMillis  the segment length, which is the deadline an upload
     *                       has to meet to keep up
     */
    public static Verdict assess(Snapshot now, int configuredCap, int runningTranscodes,
                                 int segmentMillis) {
        int shed = Math.max(0, Math.min(configuredCap, runningTranscodes) - 1);

        // Disk first: with nowhere to write segments nothing else matters, and
        // no amount of shedding conversions creates room.
        if (now.diskFreeBytes() >= 0 && now.diskFreeBytes() < DISK_FLOOR_BYTES) {
            return new Verdict(Constraint.DISK,
                    "Only " + megabytes(now.diskFreeBytes()) + " free where segments are written. "
                            + "Streaming stops when the disk fills — free space on this machine.",
                    0);
        }

        if (now.memoryUsedFraction() >= 0 && now.memoryUsedFraction() >= MEMORY_CEILING) {
            return new Verdict(Constraint.MEMORY,
                    "Memory is " + percent(now.memoryUsedFraction()) + " used, with only "
                            + megabytes(now.memoryFreeBytes()) + " free. Converting fewer streams "
                            + "at once, since each conversion holds frames in memory.",
                    shed);
        }

        if (now.cpuLoad() >= 0 && now.cpuLoad() >= CPU_CEILING) {
            return new Verdict(Constraint.CPU,
                    "The processor is " + percent(now.cpuLoad()) + " busy. Converting fewer "
                            + "streams at once — a conversion is a full encode, and this machine "
                            + "has no headroom for another.",
                    shed);
        }

        // An upload that takes longer than the segment it is sending can never
        // catch up: the next segment is already waiting. That is the uplink,
        // not the machine, and it is the failure operators most often blame on
        // the software.
        if (segmentMillis > 0 && now.uploadMillisPerSegment() > segmentMillis) {
            return new Verdict(Constraint.UPLINK,
                    "Segments are taking " + seconds(now.uploadMillisPerSegment()) + " to upload "
                            + "against a " + seconds(segmentMillis) + " segment, so this site is "
                            + "falling behind live. The connection cannot carry this many streams.",
                    shed);
        }

        if (now.uploadFailures() > 0) {
            return new Verdict(Constraint.UPLINK,
                    now.uploadFailures() + " segment upload"
                            + (now.uploadFailures() == 1 ? "" : "s")
                            + " failed. Viewers see gaps until the connection recovers.",
                    Math.min(configuredCap, Math.max(shed, 1)));
        }

        return new Verdict(Constraint.NONE, "", configuredCap);
    }

    private static String percent(double fraction) {
        return Math.round(fraction * 100) + "%";
    }

    private static String megabytes(long bytes) {
        if (bytes < 0) {
            return "an unknown amount";
        }
        long mb = bytes / (1024 * 1024);
        return mb >= 1024 ? String.format("%.1f GB", mb / 1024.0) : mb + " MB";
    }

    private static String seconds(long millis) {
        return String.format("%.1fs", millis / 1000.0);
    }
}
