package online.camstream.agent.publish;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.config.CameraConfig;
import online.camstream.agent.config.StreamProfile;
import online.camstream.agent.control.CameraRegistry;
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
import java.util.function.Supplier;

/**
 * The agent's control-plane client. Entirely event-driven.
 *
 * There is no heartbeat. Liveness comes from the MQTT connection itself, which
 * AWS IoT reports as a presence event, so an idle site makes no requests at all.
 * A report is sent when the agent connects or when what it can see changes;
 * configuration is fetched when a version push says it is stale.
 *
 * Configuration arrives over HTTPS rather than in the MQTT message because
 * credentials and camera assignments outgrow both the 128KB message limit and
 * the 8KB shadow limit on a large site — MQTT carries only the version number.
 */
public final class DeviceClient {

    private static final Logger log = LoggerFactory.getLogger(DeviceClient.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final AgentConfig config;
    private final AwsCredentialsProvider credentials;
    private final AwsV4HttpSigner signer = AwsV4HttpSigner.create();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final String base;
    private final String agentVersion;


    private final Supplier<String> publicKey;
    private final Supplier<List<DiscoveredCamera>> discovered;
    private final Supplier<List<?>> taskHealth;
    private final CredentialEnvelope envelope;
    private final CredentialStore credentialStore;
    private final CameraRegistry registry;

    /** Hash of the last report sent, so an unchanged view costs nothing. */
    private volatile int lastReportHash;
    private volatile long configVersion = -1;

    /**
     * Whether the last attempt to fetch configuration failed.
     *
     * Configuration is fetched when the agent connects and when the control
     * plane pushes a new version. Both are events: if the fetch on connect
     * fails and no push follows, nothing tries again, and the agent runs
     * indefinitely with no credentials and no cameras while looking perfectly
     * healthy - connected, heartbeating, discovering devices it cannot
     * authenticate against.
     *
     * That is not hypothetical. A Raspberry Pi with no clock battery booted
     * thirty-nine days behind, every signed request was refused as 403, and
     * the agent sat inert for a day; the console said the camera was
     * registered but its agent had not reported it. Any throttle, 5xx or
     * network blip at start-up does the same thing.
     */
    private volatile boolean configurationOwed = true;

    public DeviceClient(
            AgentConfig config,
            AwsCredentialsProvider credentials,
            Supplier<String> publicKey,
            Supplier<List<DiscoveredCamera>> discovered,
            Supplier<List<?>> taskHealth,
            CredentialEnvelope envelope,
            CredentialStore credentialStore,
            CameraRegistry registry) {
        this.config = config;
        this.credentials = credentials;
        this.publicKey = publicKey;
        this.discovered = discovered;
        this.taskHealth = taskHealth;
        this.envelope = envelope;
        this.credentialStore = credentialStore;
        this.registry = registry;
        this.base = config.apiInvokeUrl.endsWith("/")
                ? config.apiInvokeUrl.substring(0, config.apiInvokeUrl.length() - 1)
                : config.apiInvokeUrl;
        this.agentVersion = version();
    }

    /** The version stamped into the jar's manifest, or "dev" from a checkout. */
    public static String version() {
        String implVersion = DeviceClient.class.getPackage().getImplementationVersion();
        return implVersion == null ? "dev" : implVersion;
    }

    /**
     * Sends the agent's view of itself.
     *
     * @param force send even when nothing changed, as on a fresh connection
     */
    public void report(boolean force) {
        try {
            byte[] body = buildReport();
            int hash = java.util.Arrays.hashCode(body);
            if (!force && hash == lastReportHash) {
                return;
            }
            HttpResponse<String> response = send(SdkHttpMethod.POST, "/api/device/report", body);
            if (response.statusCode() / 100 == 2) {
                lastReportHash = hash;
                log.debug("report accepted");
            } else {
                log.warn("report rejected: {} {}", response.statusCode(), response.body());
            }
        } catch (Exception e) {
            log.warn("could not send report: {}", e.toString());
        }
    }

    /**
     * Whether this agent still needs its configuration.
     *
     * True until a fetch has succeeded, and true again after one fails, so the
     * supervisor can keep asking. A configured agent answers false and the
     * retry costs nothing.
     */
    public boolean needsConfiguration() {
        return configurationOwed || configVersion < 0;
    }

    /**
     * Says so when the clock is why a request was refused.
     *
     * Every signed request carries a timestamp, and AWS refuses one more than
     * a few minutes out. The refusal itself says only "Forbidden", which sends
     * whoever reads the log looking at credentials and IAM policies - the two
     * things that are fine. The server's own Date header is the answer, and it
     * arrives on the very response that failed.
     */
    private static void warnAboutClockSkew(HttpResponse<String> response) {
        response.headers().firstValue("date").ifPresent(header -> {
            try {
                long server = java.time.ZonedDateTime
                        .parse(header, java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)
                        .toInstant().toEpochMilli();
                long skew = Math.abs(System.currentTimeMillis() - server) / 1000;
                if (skew > 300) {
                    log.error("this machine's clock is {} minutes from the server's ({} vs {}). "
                            + "Signed requests are refused until it is corrected - check NTP; "
                            + "a board with no clock battery cannot fix this by itself.",
                            skew / 60, java.time.Instant.now(), java.time.Instant.ofEpochMilli(server));
                }
            } catch (Exception ignored) {
                // A header we cannot parse is not worth a second failure.
            }
        });
    }

    /** Fetches configuration if the pushed version is newer than what we hold. */
    public void fetchConfig(long pushedVersion) {
        if (pushedVersion >= 0 && pushedVersion == configVersion) {
            return;
        }
        try {
            HttpResponse<String> response = send(SdkHttpMethod.GET, "/api/device/config", null);
            if (response.statusCode() / 100 != 2) {
                log.warn("config fetch rejected: {} {}", response.statusCode(), response.body());
                warnAboutClockSkew(response);
                configurationOwed = true;
                return;
            }
            JsonNode root = MAPPER.readTree(response.body());
            configVersion = root.path("configVersion").asLong(0);
            configurationOwed = false;

            Map<String, String> envelopes = new java.util.LinkedHashMap<>();
            for (JsonNode node : root.path("credentials")) {
                String ciphertext = node.path("ciphertext").asText(null);
                if (ciphertext != null && !ciphertext.isBlank()) {
                    envelopes.put(node.path("scope").asText("*"), ciphertext);
                }
            }
            // Unconditionally, including when the document carries none. This
            // used to be guarded on the map being non-empty, so withdrawing
            // the last credential left the agent still holding it — the one
            // case where revocation most obviously had to work.
            credentialStore.apply(envelope, envelopes);

            List<CameraRegistry.Approved> approved = new java.util.ArrayList<>();
            for (JsonNode node : root.path("approvedCameras")) {
                String identity = node.path("identity").asText(null);
                String cameraId = node.path("cameraId").asText(null);
                if (identity == null || cameraId == null) {
                    continue;
                }
                approved.add(new CameraRegistry.Approved(
                        identity, cameraId, node.path("displayName").asText(cameraId),
                        node.path("subProfileToken").asText(null),
                        node.path("mainProfileToken").asText(null)));
            }
            registry.setApproved(approved);

            // Set from the console, because how much CPU this box can spare is
            // something the operator knows and the agent cannot measure.
            JsonNode cap = root.path("maxConcurrentTranscodes");
            if (cap.isInt() && cap.asInt() >= 0 && cap.asInt() <= 64
                    && cap.asInt() != config.maxConcurrentTranscodes) {
                log.info("concurrent transcode limit set to {} (was {})",
                        cap.asInt(), config.maxConcurrentTranscodes);
                config.maxConcurrentTranscodes = cap.asInt();
            }

            log.info("configuration v{} applied: {} credential(s), {} assigned camera(s)",
                    configVersion, envelopes.size(), approved.size());

            // The assignment may have made new cameras publishable, which the
            // control plane should know about.
            report(false);
        } catch (Exception e) {
            log.warn("could not fetch configuration: {}", e.toString());
        }
    }

    private HttpResponse<String> send(SdkHttpMethod method, String path, byte[] body) throws Exception {
        URI uri = URI.create(base + path);
        SdkHttpRequest.Builder unsigned = SdkHttpRequest.builder()
                .method(method).uri(uri).putHeader("host", uri.getHost());
        if (body != null) {
            unsigned.putHeader("content-type", "application/json");
        }

        byte[] payload = body == null ? new byte[0] : body;
        SignedRequest signed = signer.sign(r -> r
                .identity(credentials.resolveCredentials())
                .request(unsigned.build())
                .payload(() -> new ByteArrayInputStream(payload))
                .putProperty(AwsV4HttpSigner.SERVICE_SIGNING_NAME, "execute-api")
                .putProperty(AwsV4HttpSigner.REGION_NAME, Region.of(config.region).id()));

        HttpRequest.Builder request = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20));
        if (body == null) {
            request.GET();
        } else {
            request.POST(HttpRequest.BodyPublishers.ofByteArray(body));
        }
        for (Map.Entry<String, List<String>> header : signed.request().headers().entrySet()) {
            // The JDK client owns these and rejects attempts to set them.
            String name = header.getKey().toLowerCase();
            if (name.equals("host") || name.equals("content-length") || name.equals("connection")) {
                continue;
            }
            for (String value : header.getValue()) {
                request.header(header.getKey(), value);
            }
        }
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private byte[] buildReport() {
        ObjectNode root = MAPPER.createObjectNode();
        root.put("siteName", config.siteName == null ? config.deviceId : config.siteName);
        root.put("agentVersion", agentVersion);
        // Published so the admin console can encrypt credentials only this
        // device can open.
        root.put("credentialPublicKey", publicKey.get());

        ArrayNode health = root.putArray("taskHealth");
        for (Object entry : taskHealth.get()) {
            health.add(String.valueOf(entry));
        }

        ArrayNode cameras = root.putArray("cameras");
        for (CameraConfig camera : registry.reportable()) {
            ObjectNode node = cameras.addObject();
            node.put("cameraId", camera.id);
            node.put("displayName", camera.name);
            if (camera.sourceCodec != null && !camera.sourceCodec.isBlank()) {
                node.put("sourceCodec", camera.sourceCodec);
            }
            // The profile travels with the codec because it decides playability
            // on its own: H.264 High 10 carries codec name "h264" and no
            // browser will decode it.
            if (camera.sourceCodecProfile != null && !camera.sourceCodecProfile.isBlank()) {
                node.put("sourceCodecProfile", camera.sourceCodecProfile);
            }
            // Where it is and what it is, so the console can show both beside
            // the identity without the operator opening the discovery list.
            if (camera.ipAddress != null && !camera.ipAddress.isBlank()) {
                node.put("ipAddress", camera.ipAddress);
            }
            if (camera.macAddress != null && !camera.macAddress.isBlank()) {
                node.put("macAddress", camera.macAddress);
            }
            // The grid shows the sub stream, so those are the dimensions the
            // console means by "resolution". It read them from the record and
            // they were never written, so the field was dead on both ends.
            Integer width = camera.widthFor(StreamProfile.SUB);
            Integer height = camera.heightFor(StreamProfile.SUB);
            if (width != null && width > 0 && height != null && height > 0) {
                node.put("width", width);
                node.put("height", height);
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
            node.put("identityStable", camera.identityStable);
            node.put("ipAddress", camera.ipAddress);
            if (camera.macAddress != null) node.put("macAddress", camera.macAddress);
            if (camera.manufacturer != null) node.put("manufacturer", camera.manufacturer);
            if (camera.model != null) node.put("model", camera.model);
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
