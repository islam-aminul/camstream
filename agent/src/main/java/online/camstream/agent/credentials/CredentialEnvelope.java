package online.camstream.agent.credentials;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import java.nio.charset.StandardCharsets;
import java.security.spec.MGF1ParameterSpec;
import java.util.Base64;

/**
 * Opens a credential that the control plane stored but could not read.
 *
 * RSA-OAEP with SHA-256, matching what WebCrypto produces in the admin browser
 * ({@code RSA-OAEP} with {@code hash: "SHA-256"}). A 2048-bit key leaves ~190
 * bytes of plaintext, which comfortably fits a username and password; anything
 * larger is rejected rather than silently truncated.
 */
public final class CredentialEnvelope {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public record Credential(String username, String password) {}

    private final DeviceKeypair keypair;

    public CredentialEnvelope(DeviceKeypair keypair) {
        this.keypair = keypair;
    }

    /**
     * @param ciphertextBase64 as stored by the control plane
     * @throws IllegalArgumentException if it was not encrypted for this device
     */
    public Credential open(String ciphertextBase64) {
        byte[] plaintext;
        try {
            Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
            // WebCrypto always uses MGF1-SHA256 with an empty label; the JCE
            // default is MGF1-SHA1, so it has to be stated explicitly or the
            // two ends silently disagree.
            cipher.init(Cipher.DECRYPT_MODE, keypair.privateKey(), new OAEPParameterSpec(
                    "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT));
            plaintext = cipher.doFinal(Base64.getDecoder().decode(ciphertextBase64));
        } catch (Exception e) {
            throw new IllegalArgumentException("Credential was not encrypted for this device", e);
        }

        try {
            JsonNode node = MAPPER.readTree(new String(plaintext, StandardCharsets.UTF_8));
            String username = node.path("username").asText(null);
            if (username == null || username.isBlank()) {
                throw new IllegalArgumentException("Credential contains no username");
            }
            return new Credential(username, node.path("password").asText(""));
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException("Credential payload is not the expected JSON", e);
        }
    }
}
