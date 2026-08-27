package online.camstream.agent.control;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.StreamProfile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.crt.mqtt.MqttClientConnection;
import software.amazon.awssdk.crt.mqtt.QualityOfService;
import software.amazon.awssdk.iot.AwsIotMqttConnectionBuilder;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.ExecutionException;

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

        /** A one-off instruction such as "scan now". */
        void onCommand(String action);

        /** The connection came up — report, and reconcile configuration. */
        void onConnected();
    }

    private final MqttClientConnection connection;
    private final String prefix;

    public WatchListener(AgentConfig config, Handlers handlers) {
        this.prefix = "camstream/" + config.thingName();

        try (AwsIotMqttConnectionBuilder builder = AwsIotMqttConnectionBuilder
                .newMtlsBuilderFromPath(config.certificatePath, config.privateKeyPath)) {
            this.connection = builder
                    .withEndpoint(config.iotDataEndpoint)
                    .withClientId(config.thingName())
                    .withCleanSession(true)
                    .withKeepAliveSecs(30)
                    .build();
        }

        try {
            connection.connect().get();
            log.info("connected to {} as {}", config.iotDataEndpoint, config.thingName());

            subscribe(prefix + "/watch", payload ->
                    handlers.onDesiredState(parse(payload)));
            subscribe(prefix + "/config", payload ->
                    handlers.onConfigVersion(MAPPER.readTree(payload).path("configVersion").asLong(-1)));
            subscribe(prefix + "/command", payload ->
                    handlers.onCommand(MAPPER.readTree(payload).path("action").asText("")));

            // Only after subscriptions exist, so nothing published in response
            // to the report is missed.
            handlers.onConnected();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted connecting to AWS IoT", e);
        } catch (ExecutionException e) {
            throw new IllegalStateException("Could not connect to AWS IoT", e.getCause());
        }
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

    /** A malformed message must never take down the connection. */
    private void subscribe(String topic, PayloadHandler handler)
            throws InterruptedException, ExecutionException {
        connection.subscribe(topic, QualityOfService.AT_LEAST_ONCE, message -> {
            try {
                handler.accept(new String(message.getPayload(), StandardCharsets.UTF_8));
            } catch (Exception e) {
                log.warn("ignoring malformed message on {}: {}", topic, e.toString());
            }
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
