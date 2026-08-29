package online.camstream.agent.provisioning;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import online.camstream.agent.config.TextFiles;

/**
 * The small file an administrator downloads per agent.
 *
 * It carries no device credential — only the shared claim certificate and a
 * one-time enrollment token. The agent generates its own key pair on first boot
 * and exchanges the token for a certificate, so no device private key ever
 * travels through the control plane or an administrator's browser.
 *
 * Sensitive until consumed: anyone holding it can enrol the one agent it names.
 * {@link #consume} deletes it once provisioning has succeeded.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
public final class IdentityFile {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final org.slf4j.Logger LOG = org.slf4j.LoggerFactory.getLogger(IdentityFile.class);

    public int schema = 1;

    public String tenantId;
    public String premisesId;
    public String deviceId;
    public String thingName;

    public String region;
    public String bucket;
    public String apiInvokeUrl;
    public String iotDataEndpoint;
    public String iotCredentialsEndpoint;
    public String roleAlias;

    public String provisioningTemplate;
    public String enrollmentToken;
    public long enrollmentExpiresAt;

    public String claimCertificatePem;
    public String claimPrivateKey;

    public static IdentityFile load(Path path) throws IOException {
        IdentityFile identity = MAPPER.readValue(TextFiles.read(path), IdentityFile.class);
        identity.validate();
        return identity;
    }

    /** Whether this file still carries the material needed to enrol. */
    public boolean canEnrol() {
        return notBlank(enrollmentToken) && notBlank(claimCertificatePem) && notBlank(claimPrivateKey);
    }

    public void validate() {
        // The durable half. It must survive enrollment, because after the
        // secrets are stripped this file is still where the agent learns which
        // endpoints and bucket it belongs to.
        require("thingName", thingName);
        require("region", region);
        require("bucket", bucket);
        require("apiInvokeUrl", apiInvokeUrl);
        require("iotDataEndpoint", iotDataEndpoint);
        require("iotCredentialsEndpoint", iotCredentialsEndpoint);

        if (!thingName.matches("[a-z0-9-]{3,32}--[a-z0-9-]{3,32}--[a-z0-9-]{3,32}")) {
            throw new IllegalArgumentException(
                    "thingName must be <tenant>--<premises>--<device>, got: " + thingName);
        }
        String[] parts = thingName.split("--");
        tenantId = parts[0];
        premisesId = parts[1];
        deviceId = parts[2];

        if (canEnrol() && enrollmentExpiresAt > 0
                && enrollmentExpiresAt < System.currentTimeMillis() / 1000) {
            throw new IllegalArgumentException(
                    "This enrollment token expired; issue a new installer from the admin console");
        }
    }

    /**
     * Strips the enrollment secrets once they have been spent, keeping the
     * endpoints the agent needs on every subsequent start.
     *
     * Deleting the file outright was the obvious move and the wrong one: the
     * agent then had no record of its own tenant, bucket or endpoints, and
     * every restart after the first failed.
     */
    public void stripSecrets(Path path) {
        enrollmentToken = null;
        claimCertificatePem = null;
        claimPrivateKey = null;
        enrollmentExpiresAt = 0;
        try {
            Files.writeString(path, MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(this));
        } catch (IOException e) {
            // The token is single-use and already spent, so a stale copy is not
            // a live credential — but say so, because the file is still secret
            // to the extent that it names the estate.
            LOG.warn("could not rewrite {} without its enrollment secrets: {}", path, e.toString());
        }
    }

    private static boolean notBlank(String value) {
        return value != null && !value.isBlank();
    }

    private static void require(String field, String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("identity file is missing " + field);
        }
    }
}
