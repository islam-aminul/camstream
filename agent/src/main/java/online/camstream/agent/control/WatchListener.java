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
import java.util.function.Consumer;

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

    private final MqttClientConnection connection;
    private final String topic;

    public WatchListener(AgentConfig config, Consumer<Set<Rendition>> onDesiredState) {
        this.topic = "camstream/" + config.thingName() + "/watch";

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
            connection.subscribe(topic, QualityOfService.AT_LEAST_ONCE, message -> {
                try {
                    onDesiredState.accept(parse(new String(message.getPayload(), StandardCharsets.UTF_8)));
                } catch (RuntimeException e) {
                    log.warn("ignoring malformed watch message: {}", e.toString());
                }
            }).get();
            log.info("subscribed to {}", topic);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted connecting to AWS IoT", e);
        } catch (ExecutionException e) {
            throw new IllegalStateException("Could not connect to AWS IoT", e.getCause());
        }
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
                desired.add(new Rendition(cameraId, StreamProfile.fromKey(node.path("profile").asText("sub"))));
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
