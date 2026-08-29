package online.camstream.agent.publish;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import online.camstream.agent.health.Resources;
import online.camstream.agent.supervise.Supervisor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.function.Supplier;

/**
 * Reports that the agent is not merely connected but working.
 *
 * AWS IoT presence events already cover the connection itself, immediately and
 * for nothing, which is why the original 30-second HTTPS poll was removed. They
 * only answer one question though — is the socket up — and the failures that
 * actually strand a site do not touch the socket. An encoder that exits on
 * every restart, a camera refusing every RTSP connection, a disk with no room
 * for segments: through all of those the MQTT session stays perfectly healthy
 * and the console keeps showing a green agent.
 *
 * So this publishes a small health record, and does it slowly. The cadence
 * follows demand rather than a fixed timer: while renditions are being
 * published a stall is costing a viewer their stream right now, and while
 * nothing is being watched there is little to say and every message is
 * billable. The idle rate is the one that dominates the bill, because idle is
 * what an ordinary site is nearly all of the time.
 *
 * Nothing subscribes to the result. An IoT rule writes it straight to DynamoDB,
 * so a heartbeat costs one MQTT message and one small write — no Lambda, no API
 * Gateway request, nothing that has to be running to receive it.
 */
public final class Heartbeat {

    private static final Logger log = LoggerFactory.getLogger(Heartbeat.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** What the agent can say about itself without doing any extra work. */
    public interface Vitals {
        int publishing();

        int camerasConfigured();

        List<Supervisor.TaskHealth> taskHealth();

        /**
         * What the machine has left, and what that means for how much it
         * should be asked to do.
         *
         * Carried on the heartbeat rather than polled, because it is the same
         * question the heartbeat already answers — is this agent well — and a
         * second channel would be a second thing to keep alive.
         */
        Resources.Verdict resources();

        /** The sample the verdict was drawn from, for the numbers themselves. */
        Resources.Snapshot vitalSigns();
    }

    private final Publisher publisher;
    private final Vitals vitals;
    private final String agentVersion;
    private final Duration activeInterval;
    private final Duration idleInterval;
    private final Supplier<Instant> clock;
    private final Instant startedAt;

    private Instant lastSent;
    /** Sending on the edge itself, so a stream starting or stopping is never missed. */
    private int lastPublishing = -1;

    @FunctionalInterface
    public interface Publisher {
        void publish(String suffix, String payload);
    }

    public Heartbeat(Publisher publisher, Vitals vitals, String agentVersion,
                     Duration activeInterval, Duration idleInterval) {
        this(publisher, vitals, agentVersion, activeInterval, idleInterval, Instant::now);
    }

    Heartbeat(Publisher publisher, Vitals vitals, String agentVersion,
              Duration activeInterval, Duration idleInterval, Supplier<Instant> clock) {
        this.publisher = publisher;
        this.vitals = vitals;
        this.agentVersion = agentVersion;
        this.activeInterval = activeInterval;
        this.idleInterval = idleInterval;
        this.clock = clock;
        this.startedAt = clock.get();
    }

    /**
     * Called far more often than it publishes.
     *
     * Ticking cheaply and deciding here keeps the schedule adaptive without
     * needing a supervisor that can be rescheduled: the decision depends on
     * state that changes between ticks.
     */
    public void tick() {
        Instant now = clock.get();
        int publishing = vitals.publishing();
        boolean demandChanged = publishing != lastPublishing;
        Duration due = publishing > 0 ? activeInterval : idleInterval;

        if (!demandChanged && lastSent != null && Duration.between(lastSent, now).compareTo(due) < 0) {
            return;
        }
        send(now, publishing);
    }

    /** Reports immediately, whatever the schedule says — used on connect. */
    public void sendNow() {
        send(clock.get(), vitals.publishing());
    }

    private void send(Instant now, int publishing) {
        ObjectNode body = MAPPER.createObjectNode();
        body.put("agentVersion", agentVersion);
        body.put("uptimeSeconds", Duration.between(startedAt, now).toSeconds());
        body.put("publishing", publishing);
        body.put("camerasConfigured", vitals.camerasConfigured());

        // Names of the tasks that are failing, not the whole health list: the
        // payload crosses the network on a schedule and an empty list is the
        // normal case, so the healthy path costs almost nothing to send.
        List<String> failing = vitals.taskHealth().stream()
                .filter(task -> !task.healthy())
                .map(Supervisor.TaskHealth::name)
                .toList();
        Resources.Verdict resources = vitals.resources();
        Resources.Snapshot signs = vitals.vitalSigns();

        // A stuck task and an exhausted machine are both "unhealthy" to the
        // console, and both need saying: a site can have a wedged encoder on a
        // machine that is also out of disk.
        body.put("healthy", failing.isEmpty() && resources.healthy());
        if (!failing.isEmpty()) {
            body.put("failingTasks", String.join(",", failing));
        }

        // The constraint and its explanation travel together. The console shows
        // the sentence; the numbers behind it are there so an operator can see
        // how close to the edge a healthy agent is running.
        body.put("constraint", resources.constraint().name().toLowerCase());
        if (!resources.message().isEmpty()) {
            body.put("constraintMessage", resources.message());
        }
        body.put("maxConcurrentTranscodes", resources.maxConcurrentTranscodes());
        putIfKnown(body, "cpuLoad", signs.cpuLoad());
        putIfKnown(body, "memoryUsedFraction", signs.memoryUsedFraction());
        putIfKnown(body, "memoryFreeBytes", signs.memoryFreeBytes());
        putIfKnown(body, "diskFreeBytes", signs.diskFreeBytes());
        putIfKnown(body, "uploadBytesPerSecond", signs.uploadBytesPerSecond());
        putIfKnown(body, "uploadMillisPerSegment", signs.uploadMillisPerSegment());

        try {
            publisher.publish("heartbeat", MAPPER.writeValueAsString(body));
            lastSent = now;
            lastPublishing = publishing;
        } catch (Exception e) {
            // A failed publish must not stop the agent; the next tick retries.
            log.debug("could not publish heartbeat: {}", e.toString());
        }
    }

    /**
     * Omits a reading the platform would not give, rather than sending -1.
     *
     * A missing field is honestly absent; a -1 in the record would be rendered
     * by something downstream as a real measurement.
     */
    private static void putIfKnown(ObjectNode body, String name, double value) {
        if (value >= 0) {
            body.put(name, value);
        }
    }

    private static void putIfKnown(ObjectNode body, String name, long value) {
        if (value >= 0) {
            body.put(name, value);
        }
    }
}
