package online.camstream.agent.publish;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.credentials.CredentialEnvelope;
import online.camstream.agent.credentials.CredentialStore;
import online.camstream.agent.discovery.DiscoveredCamera;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.http.SdkHttpMethod;
import software.amazon.awssdk.http.SdkHttpRequest;
import software.amazon.awssdk.http.auth.aws.signer.AwsV4HttpSigner;
import software.amazon.awssdk.http.auth.spi.signer.SignedRequest;
import software.amazon.awssdk.regions.Region;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Announces this device and its cameras to the control plane.
 *
 * Signed with SigV4 using the same IoT-issued credentials that write to S3, so
 * the API can trust the caller's identity from the assumed-role session name
 * rather than anything in the request body.
 */
public final class HeartbeatClient {

    private static final Logger log = LoggerFactory.getLogger(HeartbeatClient.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final AgentConfig config;
    private final AwsCredentialsProvider credentials;
    private final AwsV4HttpSigner signer = AwsV4HttpSigner.create();
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private final URI endpoint;
    private final String agentVersion;
    private final java.util.function.Supplier<String> publicKey;
    private final java.util.function.Supplier<List<DiscoveredCamera>> discovered;
    private final CredentialEnvelope envelope;
    private final CredentialStore credentialStore;

    public HeartbeatClient(
            AgentConfig config,
            AwsCredentialsProvider credentials,
            java.util.function.Supplier<String> publicKey,
            java.util.function.Supplier<List<DiscoveredCamera>> discovered,
            CredentialEnvelope envelope,
            CredentialStore credentialStore) {
        this.config = config;
        this.credentials = credentials;
        this.publicKey = publicKey;
        this.discovered = discovered;
        this.envelope = envelope;
        this.credentialStore = credentialStore;
        String base = config.apiInvokeUrl.endsWith("/")
                ? config.apiInvokeUrl.substring(0, config.apiInvokeUrl.length() - 1)
                : config.apiInvokeUrl;
        this.endpoint = URI.create(base + "/api/device/heartbeat");
        String implVersion = HeartbeatClient.class.getPackage().getImplementationVersion();
        this.agentVersion = implVersion == null ? "dev" : implVersion;
    }

    public void send() {
        try {
            byte[] body = buildBody();
            SdkHttpRequest unsigned = SdkHttpRequest.builder()
                    .method(SdkHttpMethod.POST)
                    .uri(endpoint)
                    .putHeader("content-type", "application/json")
                    .putHeader("host", endpoint.getHost())
                    .build();

            SignedRequest signed = signer.sign(r -> r
                    .identity(credentials.resolveCredentials())
                    .request(unsigned)
                    .payload(() -> new ByteArrayInputStream(body))
                    .putProperty(AwsV4HttpSigner.SERVICE_SIGNING_NAME, "execute-api")
                    .putProperty(AwsV4HttpSigner.REGION_NAME, Region.of(config.region).id()));

            HttpRequest.Builder request = HttpRequest.newBuilder(endpoint)
                    .timeout(Duration.ofSeconds(15))
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body));
            for (Map.Entry<String, List<String>> header : signed.request().headers().entrySet()) {
                // The JDK client manages these itself and rejects attempts to set them.
                String name = header.getKey().toLowerCase();
                if (name.equals("host") || name.equals("content-length") || name.equals("connection")) {
                    continue;
                }
                for (String value : header.getValue()) {
                    request.header(header.getKey(), value);
                }
            }

            HttpResponse<String> response = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() / 100 != 2) {
                log.warn("heartbeat rejected: {} {}", response.statusCode(), response.body());
            } else {
                acceptCredentials(response.body());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            // A missed heartbeat only delays the camera list; never fatal.
            log.warn("heartbeat failed: {}", e.toString());
        }
    }

    /**
     * The response may carry credentials an administrator entered in the web
     * UI. They arrive encrypted to this device's public key, so the control
     * plane relayed them without ever being able to read them.
     */
    private void acceptCredentials(String body) {
        try {
            JsonNode envelopes = MAPPER.readTree(body).path("credentials");
            if (!envelopes.isArray() || envelopes.isEmpty()) {
                return;
            }
            java.util.Map<String, String> byScope = new java.util.LinkedHashMap<>();
            for (JsonNode node : envelopes) {
                String ciphertext = node.path("ciphertext").asText(null);
                if (ciphertext != null && !ciphertext.isBlank()) {
                    byScope.put(node.path("scope").asText("*"), ciphertext);
                }
            }
            if (!byScope.isEmpty()) {
                credentialStore.apply(envelope, byScope);
                log.info("accepted {} credential envelope(s); {} credential(s) now known",
                        byScope.size(), credentialStore.size());
            }
        } catch (Exception e) {
            log.warn("could not read credentials from the heartbeat response: {}", e.toString());
        }
    }

    private byte[] buildBody() {
        ObjectNode root = MAPPER.createObjectNode();
        root.put("siteName", config.siteName == null ? config.deviceId : config.siteName);
        root.put("agentVersion", agentVersion);
        // Published so the admin UI can encrypt credentials that only this
        // device can open.
        root.put("credentialPublicKey", publicKey.get());

        ArrayNode cameras = root.putArray("cameras");
        for (CameraConfig camera : config.cameras) {
            ObjectNode node = cameras.addObject();
            node.put("cameraId", camera.id);
            node.put("displayName", camera.name);
            if (camera.sourceCodec != null && !camera.sourceCodec.isBlank()) {
                node.put("sourceCodec", camera.sourceCodec);
            }
            ArrayNode profiles = node.putArray("profiles");
            for (StreamProfile profile : StreamProfile.values()) {
                if (camera.supports(profile)) {
                    profiles.add(profile.key());
                }
            }
        }
        // Redacted by construction: DiscoveredCamera.redacted() drops the RTSP
        // URLs, which embed credentials.
        ArrayNode candidates = root.putArray("discovered");
        for (DiscoveredCamera camera : discovered.get()) {
            ObjectNode node = candidates.addObject();
            node.put("id", camera.id);
            node.put("ipAddress", camera.ipAddress);
            if (camera.macAddress != null) node.put("macAddress", camera.macAddress);
            if (camera.manufacturer != null) node.put("manufacturer", camera.manufacturer);
            if (camera.model != null) node.put("model", camera.model);
            if (camera.firmware != null) node.put("firmware", camera.firmware);
            node.put("authState", camera.authState.name());
            if (camera.note != null) node.put("note", camera.note);
            ArrayNode profiles = node.putArray("profiles");
            camera.profiles.forEach((token, profile) -> {
                ObjectNode p = profiles.addObject();
                p.put("token", token);
                if (profile.name != null) p.put("name", profile.name);
                if (profile.codec != null) p.put("codec", profile.codec);
                if (profile.width != null) p.put("width", profile.width);
                if (profile.height != null) p.put("height", profile.height);
                if (profile.fps != null) p.put("fps", profile.fps);
            });
        }
        return root.toString().getBytes(StandardCharsets.UTF_8);
    }
}
