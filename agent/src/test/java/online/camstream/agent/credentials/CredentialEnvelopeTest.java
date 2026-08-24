package online.camstream.agent.credentials;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.*;

class CredentialEnvelopeTest {

    /** Encrypts exactly as WebCrypto's RSA-OAEP with SHA-256 does in the browser. */
    private static String sealLikeWebCrypto(String publicKeyBase64, String json) throws Exception {
        PublicKey publicKey = KeyFactory.getInstance("RSA")
                .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(publicKeyBase64)));
        Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
        cipher.init(Cipher.ENCRYPT_MODE, publicKey, new OAEPParameterSpec(
                "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT));
        return Base64.getEncoder().encodeToString(cipher.doFinal(json.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void opensACredentialSealedInTheBrowser(@TempDir Path dir) throws Exception {
        DeviceKeypair keypair = DeviceKeypair.loadOrCreate(dir.resolve("key.pem"));
        String sealed = sealLikeWebCrypto(keypair.publicKeyBase64(),
                "{\"username\":\"admin\",\"password\":\"p@ss w0rd\"}");

        CredentialEnvelope.Credential credential = new CredentialEnvelope(keypair).open(sealed);
        assertEquals("admin", credential.username());
        assertEquals("p@ss w0rd", credential.password());
    }

    @Test
    void survivesARestart(@TempDir Path dir) throws Exception {
        Path keyPath = dir.resolve("key.pem");
        DeviceKeypair first = DeviceKeypair.loadOrCreate(keyPath);
        String sealed = sealLikeWebCrypto(first.publicKeyBase64(), "{\"username\":\"u\",\"password\":\"p\"}");

        DeviceKeypair reloaded = DeviceKeypair.loadOrCreate(keyPath);
        assertEquals(first.publicKeyBase64(), reloaded.publicKeyBase64());
        assertEquals("p", new CredentialEnvelope(reloaded).open(sealed).password());
    }

    @Test
    void refusesACredentialSealedForAnotherDevice(@TempDir Path dir) throws Exception {
        DeviceKeypair intended = DeviceKeypair.loadOrCreate(dir.resolve("a.pem"));
        DeviceKeypair other = DeviceKeypair.loadOrCreate(dir.resolve("b.pem"));
        String sealed = sealLikeWebCrypto(intended.publicKeyBase64(), "{\"username\":\"u\",\"password\":\"p\"}");

        assertThrows(IllegalArgumentException.class, () -> new CredentialEnvelope(other).open(sealed));
    }

    @Test
    void rejectsAPayloadThatIsNotACredential(@TempDir Path dir) throws Exception {
        DeviceKeypair keypair = DeviceKeypair.loadOrCreate(dir.resolve("key.pem"));
        String sealed = sealLikeWebCrypto(keypair.publicKeyBase64(), "{\"password\":\"orphan\"}");
        assertThrows(IllegalArgumentException.class, () -> new CredentialEnvelope(keypair).open(sealed));
    }

    @Test
    void writesThePrivateKeyWithRestrictivePermissions(@TempDir Path dir) throws Exception {
        Path keyPath = dir.resolve("key.pem");
        DeviceKeypair.loadOrCreate(keyPath);
        try {
            var permissions = Files.getPosixFilePermissions(keyPath);
            assertEquals(2, permissions.size(), "owner read/write only, got " + permissions);
        } catch (UnsupportedOperationException e) {
            // Windows uses ACL inheritance instead; nothing to assert.
        }
    }
}
