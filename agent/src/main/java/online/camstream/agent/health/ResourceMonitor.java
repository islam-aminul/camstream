package online.camstream.agent.health;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Samples the machine this agent is running on.
 *
 * Deliberately thin: it reads what the platform will tell it and records what
 * the agent itself observes, and makes no decisions — those are in
 * {@link Resources}, where they can be tested without a real processor.
 *
 * Every reading is optional. The JVM's extended OS bean is available on the
 * platforms this ships to, but it is not part of the specification, and a
 * value it declines to give is reported as -1 rather than guessed. Reading an
 * unknown as zero would report every machine as idle.
 */
public final class ResourceMonitor {

    private static final Logger log = LoggerFactory.getLogger(ResourceMonitor.class);

    /** Where segments are written, which is the disk that has to have room. */
    private final Path workingDirectory;

    private final com.sun.management.OperatingSystemMXBean os;

    // The upload meter. Fed from the publisher's one choke point, and drained
    // each time a snapshot is taken, so a report covers the interval since the
    // last one rather than all of history.
    private final AtomicLong uploadedBytes = new AtomicLong();
    private final AtomicLong uploadedMillis = new AtomicLong();
    private final AtomicLong uploadCount = new AtomicLong();
    private final AtomicInteger uploadFailures = new AtomicInteger();

    public ResourceMonitor(Path workingDirectory) {
        this.workingDirectory = workingDirectory;
        this.os = extendedBean();
    }

    private static com.sun.management.OperatingSystemMXBean extendedBean() {
        try {
            java.lang.management.OperatingSystemMXBean bean =
                    ManagementFactory.getOperatingSystemMXBean();
            return bean instanceof com.sun.management.OperatingSystemMXBean extended
                    ? extended : null;
        } catch (RuntimeException e) {
            log.debug("no extended OS metrics available: {}", e.toString());
            return null;
        }
    }

    /** Records one completed upload, for the throughput figure. */
    public void recordUpload(long bytes, long millis) {
        uploadedBytes.addAndGet(bytes);
        uploadedMillis.addAndGet(millis);
        uploadCount.incrementAndGet();
    }

    /** Records one upload that did not complete at all. */
    public void recordUploadFailure() {
        uploadFailures.incrementAndGet();
    }

    /**
     * Reads the machine and drains the upload meter.
     *
     * Draining here rather than on a timer means the figures always describe
     * exactly the interval between two heartbeats, whatever that interval
     * turned out to be — and the cadence is deliberately variable.
     */
    public Resources.Snapshot sample() {
        long bytes = uploadedBytes.getAndSet(0);
        long millis = uploadedMillis.getAndSet(0);
        long count = uploadCount.getAndSet(0);
        int failures = uploadFailures.getAndSet(0);

        return new Resources.Snapshot(
                cpuLoad(),
                memoryUsedFraction(),
                physicalMemoryFree(),
                diskFree(),
                millis > 0 ? bytes * 1000 / millis : -1,
                count > 0 ? millis / count : -1,
                failures);
    }

    private double cpuLoad() {
        if (os == null) {
            return -1;
        }
        try {
            // Whole-machine load, not this process: ffmpeg does the encoding in
            // its own processes, so the JVM's own share says nothing useful.
            double load = os.getCpuLoad();
            return Double.isNaN(load) || load < 0 ? -1 : load;
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private double memoryUsedFraction() {
        if (os == null) {
            return -1;
        }
        try {
            long total = os.getTotalMemorySize();
            long free = os.getFreeMemorySize();
            return total > 0 ? (double) (total - free) / total : -1;
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private long physicalMemoryFree() {
        if (os == null) {
            return -1;
        }
        try {
            return os.getFreeMemorySize();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private long diskFree() {
        try {
            return Files.getFileStore(workingDirectory).getUsableSpace();
        } catch (Exception e) {
            // A path that has gone away is itself a problem, but not one this
            // reading can describe; the encoder will report it as a failure.
            log.debug("could not read free space for {}: {}", workingDirectory, e.toString());
            return -1;
        }
    }
}
