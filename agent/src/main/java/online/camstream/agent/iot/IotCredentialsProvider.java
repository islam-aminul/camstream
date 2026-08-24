package online.camstream.agent.iot;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import online.camstream.agent.config.AgentConfig;
import software.amazon.awssdk.auth.credentials.AwsCredentials;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.credentials.AwsSessionCredentials;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import java.time.Instant;

/**
 * Exchanges the device's X.509 certificate for temporary AWS credentials via
 * the AWS IoT Credentials Provider.
 *
 * This is what keeps the media path free of any control-plane component: the
 * agent ends up holding ordinary SigV4 credentials and writes to S3 directly,
 * so no Lambda or API Gateway invocation sits between a camera and the CDN.
 *
 * The returned role is scoped by {@code ${credentials-iot:ThingName}}, so these
 * credentials can only ever write beneath this device's own prefix.
 */
public final class IotCredentialsProvider implements AwsCredentialsProvider {

    /** Renew early — a request that starts valid must not expire mid-upload. */
    private static final Duration RENEW_BEFORE = Duration.ofMinutes(5);

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final HttpClient http;
    private final URI endpoint;
    private final String thingName;

    private volatile AwsSessionCredentials cached;
    private volatile Instant expiresAt = Instant.EPOCH;

    public IotCredentialsProvider(AgentConfig config) {
        this.thingName = config.thingName();
        this.endpoint = URI.create(
                "https://" + config.iotCredentialsEndpoint + "/role-aliases/" + config.roleAlias + "/credentials");
        this.http = HttpClient.newBuilder()
                .sslContext(mutualTlsContext(Path.of(config.keystorePath), config.keystorePassword))
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    @Override
    public AwsCredentials resolveCredentials() {
        AwsSessionCredentials current = cached;
        if (current != null && Instant.now().isBefore(expiresAt.minus(RENEW_BEFORE))) {
            return current;
        }
        synchronized (this) {
            if (cached != null && Instant.now().isBefore(expiresAt.minus(RENEW_BEFORE))) {
                return cached;
            }
            return fetch();
        }
    }

    private AwsSessionCredentials fetch() {
        HttpRequest request = HttpRequest.newBuilder(endpoint)
                .header("x-amzn-iot-thingname", thingName)
                .timeout(Duration.ofSeconds(15))
                .GET()
                .build();
        try {
            HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new IllegalStateException(
                        "IoT credentials endpoint returned " + response.statusCode() + ": " + response.body());
            }
            JsonNode credentials = MAPPER.readTree(response.body()).path("credentials");
            AwsSessionCredentials session = AwsSessionCredentials.create(
                    credentials.path("accessKeyId").asText(),
                    credentials.path("secretAccessKey").asText(),
                    credentials.path("sessionToken").asText());

            this.expiresAt = Instant.parse(credentials.path("expiration").asText());
            this.cached = session;
            return session;
        } catch (IOException e) {
            throw new IllegalStateException("Could not obtain AWS credentials for " + thingName, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted obtaining AWS credentials", e);
        }
    }

    /**
     * Builds an SSL context presenting the device certificate. The default
     * trust store is kept, which already contains the Amazon root CAs.
     */
    private static SSLContext mutualTlsContext(Path keystorePath, String password) {
        try (InputStream in = Files.newInputStream(keystorePath)) {
            char[] secret = password == null ? new char[0] : password.toCharArray();
            KeyStore keyStore = KeyStore.getInstance("PKCS12");
            keyStore.load(in, secret);

            KeyManagerFactory keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            keyManagers.init(keyStore, secret);

            SSLContext context = SSLContext.getInstance("TLSv1.2");
            context.init(keyManagers.getKeyManagers(), null, null);
            return context;
        } catch (Exception e) {
            throw new IllegalStateException("Could not load device keystore " + keystorePath, e);
        }
    }
}
