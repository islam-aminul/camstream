package online.camstream.agent.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.StreamProfile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.crt.CRT;
import software.amazon.awssdk.crt.mqtt.MqttClientConnection;
import software.amazon.awssdk.crt.mqtt.MqttClientConnectionEvents;
import software.amazon.awssdk.crt.mqtt.QualityOfService;
import software.amazon.awssdk.iot.AwsIotMqttConnectionBuilder;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Subscribes to this device's watch topic and reports the desired set of
 * renditions.
 *
 * MQTT rather than polling because the delay here is felt directly by the
 * viewer: it sits between clicking a camera and the first frame arriving.
 */
public final class WatchListener implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(WatchListener.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** What the agent reacts to, all pushed over the one connection. */
    public interface Handlers {
        void onDesiredState(Set<Rendition> desired);

        /** A newer configuration exists; fetch it. */
        void onConfigVersion(long version);

        /**
         * A one-off instruction such as "scan now" or "update to this build".
         *
         * The whole message is handed over rather than just the verb: an
         * update names a version and where to fetch it, and a channel that
         * carried only a verb would need a second one beside it.
         */
        void onCommand(String action, JsonNode command);

        /** The connection came up — report, and reconcile configuration. */
        void onConnected();
    }

    private final MqttClientConnection connection;
    private final String prefix;
    private final Handlers handlers;

    /**
     * Where handler bodies actually run.
     *
     * The CRT delivers messages on its event loop, and handling one here used
     * to mean running it there. A scan is discovery end to end — a multicast
     * probe, a sweep of every address the interface netmasks imply, then ONVIF
     * and ffprobe per candidate — which on a modest LAN is about thirty
     * seconds, the same as the keepalive. Blocking the loop for that long
     * stops the client answering its own pings, so the connection drops, and
     * the reconnect below is what a dropped connection then needs. One thread,
     * so ordering between messages is still the order they arrived in.
     */
    private final ExecutorService work = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "camstream-mqtt-work");
        thread.setDaemon(true);
        return thread;
    });

    private volatile boolean closed;

    public WatchListener(AgentConfig config, Handlers handlers) {
        this.prefix = "camstream/" + config.thingName();
        this.handlers = handlers;

        // A clean session means the broker keeps nothing for us, so every
        // reconnect arrives with no subscriptions at all. Nothing else would
        // notice: presence still reports the socket as up and the heartbeat
        // still publishes, so the console shows a healthy agent that has in
        // fact stopped listening.
        MqttClientConnectionEvents events = new MqttClientConnectionEvents() {
            @Override
            public void onConnectionInterrupted(int errorCode) {
                log.warn("MQTT connection interrupted: {}", CRT.awsErrorString(errorCode));
            }

            @Override
            public void onConnectionResumed(boolean sessionPresent) {
                log.info("MQTT connection resumed (sessionPresent={})", sessionPresent);
                submit("reconnect", () -> restore(sessionPresent));
            }
        };

        try (AwsIotMqttConnectionBuilder builder = AwsIotMqttConnectionBuilder
                .newMtlsBuilderFromPath(config.certificatePath, config.privateKeyPath)) {
            this.connection = builder
                    .withEndpoint(config.iotDataEndpoint)
                    .withClientId(config.thingName())
                    .withCleanSession(true)
                    .withKeepAliveSecs(30)
                    .withConnectionEventCallbacks(events)
                    .build();
        }

        try {
            connection.connect().get();
            log.info("connected to {} as {}", config.iotDataEndpoint, config.thingName());
            subscribeAll();
            // Off the calling thread, so the caller can publish this listener
            // before the handler needs to reach back into it.
            submit("connect", handlers::onConnected);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted connecting to AWS IoT", e);
        } catch (ExecutionException e) {
            throw new IllegalStateException("Could not connect to AWS IoT", e.getCause());
        }
    }

    /**
     * Puts the session back after a reconnect.
     *
     * Re-subscribing is the whole point: without it the agent holds a live
     * socket it will never hear anything on, and the only recovery is a
     * restart. Reconciling afterwards covers what was published while it was
     * away — a config push or a watch instruction sent during the gap is
     * simply gone, since neither is retained.
     */
    private void restore(boolean sessionPresent) {
        try {
            if (!sessionPresent) {
                subscribeAll();
            }
            handlers.onConnected();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.error("could not restore the MQTT session — this agent is deaf until it reconnects: {}",
                    e.toString());
        }
    }

    private void subscribeAll() throws InterruptedException, ExecutionException {
        subscribe(prefix + "/watch", payload ->
                handlers.onDesiredState(parse(payload)));
        subscribe(prefix + "/config", payload ->
                handlers.onConfigVersion(MAPPER.readTree(payload).path("configVersion").asLong(-1)));
        subscribe(prefix + "/command", payload -> {
            JsonNode command = MAPPER.readTree(payload);
            handlers.onCommand(command.path("action").asText(""), command);
        });
    }

    /** Runs work off the event loop, and never throws back onto it. */
    private void submit(String what, ThrowingRunnable body) {
        if (closed) {
            return;
        }
        try {
            work.submit(() -> {
                try {
                    body.run();
                } catch (Exception e) {
                    log.warn("[{}] handler failed: {}", what, e.toString());
                }
            });
        } catch (RejectedExecutionException e) {
            log.debug("[{}] dropped: the listener is shutting down", what);
        }
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    /**
     * Publishes on this device's own topic tree.
     *
     * QoS 0: this carries health, and health that arrives late is worth less
     * than the retry costs. A dropped heartbeat is answered by the next one.
     */
    public void publish(String suffix, String payload) {
        connection.publish(new software.amazon.awssdk.crt.mqtt.MqttMessage(
                prefix + "/" + suffix,
                payload.getBytes(StandardCharsets.UTF_8),
                QualityOfService.AT_MOST_ONCE));
    }

    /**
     * A malformed message must never take down the connection, and a slow one
     * must never take down the socket — so the payload is copied out here and
     * everything else happens on the worker.
     */
    private void subscribe(String topic, PayloadHandler handler)
            throws InterruptedException, ExecutionException {
        connection.subscribe(topic, QualityOfService.AT_LEAST_ONCE, message -> {
            String payload = new String(message.getPayload(), StandardCharsets.UTF_8);
            submit(topic, () -> {
                try {
                    handler.accept(payload);
                } catch (Exception e) {
                    log.warn("ignoring malformed message on {}: {}", topic, e.toString());
                }
            });
        }).get();
        log.info("subscribed to {}", topic);
    }

    @FunctionalInterface
    private interface PayloadHandler {
        void accept(String payload) throws Exception;
    }

    static Set<Rendition> parse(String payload) {
        try {
            JsonNode root = MAPPER.readTree(payload);
            Set<Rendition> desired = new LinkedHashSet<>();
            for (JsonNode node : root.path("renditions")) {
                String cameraId = node.path("cameraId").asText(null);
                if (cameraId == null || cameraId.isBlank()) {
                    continue;
                }
                desired.add(new Rendition(
                        cameraId,
                        StreamProfile.fromKey(node.path("profile").asText("sub")),
                        Variant.fromKey(node.path("variant").asText("source"))));
            }
            return desired;
        } catch (Exception e) {
            throw new IllegalArgumentException("bad watch payload", e);
        }
    }

    @Override
    public void close() {
        closed = true;
        // Before the disconnect, so a handler still in flight cannot resubscribe
        // a connection that is on its way down.
        work.shutdownNow();
        try {
            connection.disconnect().get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException e) {
            log.debug("error during MQTT disconnect", e);
        } finally {
            connection.close();
        }
    }
}
