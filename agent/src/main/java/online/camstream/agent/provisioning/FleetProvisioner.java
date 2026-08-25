package online.camstream.agent.provisioning;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.crt.mqtt.MqttClientConnection;
import software.amazon.awssdk.crt.mqtt.QualityOfService;
import software.amazon.awssdk.iot.AwsIotMqttConnectionBuilder;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Exchanges a shared claim certificate and a one-time token for this device's
 * own certificate, using AWS IoT fleet provisioning.
 *
 * Runs once, on first boot. The claim certificate is in every installer and can
 * do only two things — request a certificate and call the template — so the
 * token is what actually authorises enrollment, and the pre-provisioning hook
 * consumes it atomically. A captured installer therefore enrols nothing twice.
 */
public final class FleetProvisioner {

    private static final Logger log = LoggerFactory.getLogger(FleetProvisioner.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int TIMEOUT_SECONDS = 60;

    private static final String CREATE_ACCEPTED = "$aws/certificates/create/json/accepted";
    private static final String CREATE_REJECTED = "$aws/certificates/create/json/rejected";

    /** Where a provisioned identity lives, alongside the agent's other state. */
    public record DeviceCertificate(Path certificatePem, Path privateKey) {
        public boolean exists() {
            return Files.isRegularFile(certificatePem) && Files.isRegularFile(privateKey);
        }
    }

    private FleetProvisioner() {
    }

    /**
     * Provisions the device if it has no certificate yet.
     *
     * @return true when provisioning ran, false when the device was already enrolled
     */
    public static boolean ensureProvisioned(IdentityFile identity, Path stateDir) throws Exception {
        DeviceCertificate target = certificatePaths(stateDir);
        if (target.exists()) {
            log.debug("device certificate already present; skipping provisioning");
            return false;
        }

        log.info("enrolling {} via fleet provisioning", identity.thingName);
        Path claimCert = Files.createTempFile("claim", ".crt");
        Path claimKey = Files.createTempFile("claim", ".key");
        try {
            Files.writeString(claimCert, identity.claimCertificatePem);
            Files.writeString(claimKey, identity.claimPrivateKey);
            restrict(claimKey);

            provision(identity, claimCert, claimKey, target);
            log.info("enrolled; device certificate written to {}", target.certificatePem());
            return true;
        } finally {
            // The claim material is shared across every installer; do not leave
            // it lying on disk once it has served its single purpose.
            Files.deleteIfExists(claimCert);
            Files.deleteIfExists(claimKey);
        }
    }

    public static DeviceCertificate certificatePaths(Path stateDir) {
        return new DeviceCertificate(stateDir.resolve("device.crt"), stateDir.resolve("device.key"));
    }

    private static void provision(
            IdentityFile identity, Path claimCert, Path claimKey, DeviceCertificate target) throws Exception {

        MqttClientConnection connection;
        try (AwsIotMqttConnectionBuilder builder =
                     AwsIotMqttConnectionBuilder.newMtlsBuilderFromPath(claimCert.toString(), claimKey.toString())) {
            connection = builder
                    .withEndpoint(identity.iotDataEndpoint)
                    // A claim connection must not collide with the device's own
                    // client id, which it will use immediately afterwards.
                    .withClientId("provision-" + UUID.randomUUID())
                    .withCleanSession(true)
                    .withKeepAliveSecs(30)
                    .build();
        }

        try {
            connection.connect().get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

            CompletableFuture<JsonNode> created = new CompletableFuture<>();
            connection.subscribe(CREATE_ACCEPTED, QualityOfService.AT_LEAST_ONCE, message ->
                    complete(created, message.getPayload())).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            connection.subscribe(CREATE_REJECTED, QualityOfService.AT_LEAST_ONCE, message ->
                    created.completeExceptionally(rejection("certificate request", message.getPayload())))
                    .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

            connection.publish(new software.amazon.awssdk.crt.mqtt.MqttMessage(
                    "$aws/certificates/create/json", "{}".getBytes(StandardCharsets.UTF_8),
                    QualityOfService.AT_LEAST_ONCE)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

            JsonNode certificate = created.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            String certificatePem = certificate.path("certificatePem").asText();
            String privateKey = certificate.path("privateKey").asText();
            String ownershipToken = certificate.path("certificateOwnershipToken").asText();
            if (certificatePem.isEmpty() || privateKey.isEmpty() || ownershipToken.isEmpty()) {
                throw new IllegalStateException("IoT returned an incomplete certificate");
            }

            String base = "$aws/provisioning-templates/" + identity.provisioningTemplate + "/provision/json";
            CompletableFuture<JsonNode> registered = new CompletableFuture<>();
            connection.subscribe(base + "/accepted", QualityOfService.AT_LEAST_ONCE, message ->
                    complete(registered, message.getPayload())).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            connection.subscribe(base + "/rejected", QualityOfService.AT_LEAST_ONCE, message ->
                    registered.completeExceptionally(rejection("registration", message.getPayload())))
                    .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

            byte[] request = MAPPER.writeValueAsBytes(Map.of(
                    "certificateOwnershipToken", ownershipToken,
                    "parameters", Map.of(
                            "ThingName", identity.thingName,
                            "TenantId", identity.tenantId,
                            "PremisesId", identity.premisesId,
                            "EnrollmentToken", identity.enrollmentToken)));
            connection.publish(new software.amazon.awssdk.crt.mqtt.MqttMessage(
                    base, request, QualityOfService.AT_LEAST_ONCE)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

            registered.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

            // Written only after registration succeeds: a certificate saved for
            // a thing that was never registered would leave the agent stuck,
            // skipping provisioning forever while unable to connect.
            Files.createDirectories(target.certificatePem().getParent());
            Files.writeString(target.certificatePem(), certificatePem);
            Files.writeString(target.privateKey(), privateKey);
            restrict(target.privateKey());
        } finally {
            try {
                connection.disconnect().get(10, TimeUnit.SECONDS);
            } catch (Exception e) {
                log.debug("error disconnecting the provisioning session", e);
            }
            connection.close();
        }
    }

    private static void complete(CompletableFuture<JsonNode> future, byte[] payload) {
        try {
            future.complete(MAPPER.readTree(payload));
        } catch (Exception e) {
            future.completeExceptionally(e);
        }
    }

    /**
     * Reports the rejection as IoT described it, and only suggests the token
     * when the message does not already say otherwise. Guessing at the cause
     * sent an operator hunting a token problem when the real fault was an IAM
     * permission on the provisioning role.
     */
    private static Exception rejection(String stage, byte[] payload) {
        String body = new String(payload, StandardCharsets.UTF_8);
        String hint = body.contains("not authorized") || body.contains("ResourceRegistrationFailure")
                ? " This is a server-side configuration fault, not a bad token."
                : " The enrollment token may already have been used or have expired;"
                  + " issue a new installer from the admin console.";
        return new IllegalStateException("Fleet provisioning " + stage + " was rejected: " + body + hint);
    }

    private static void restrict(Path path) {
        try {
            Files.setPosixFilePermissions(path, Set.of(
                    PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        } catch (UnsupportedOperationException | java.io.IOException e) {
            // Windows relies on directory ACLs set by the installer instead.
        }
    }
}
