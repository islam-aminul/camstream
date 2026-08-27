package online.camstream.agent.publish;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
        body.put("healthy", failing.isEmpty());
        if (!failing.isEmpty()) {
            body.put("failingTasks", String.join(",", failing));
        }

        try {
            publisher.publish("heartbeat", MAPPER.writeValueAsString(body));
            lastSent = now;
            lastPublishing = publishing;
        } catch (Exception e) {
            // A failed publish must not stop the agent; the next tick retries.
            log.debug("could not publish heartbeat: {}", e.toString());
        }
    }
}
