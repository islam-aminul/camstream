package online.camstream.agent.credentials;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.junit.jupiter.api.Test;

import javax.crypto.Cipher;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.spec.MGF1ParameterSpec;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * What the agent believes about camera credentials, and — the part that was
 * missing — what it stops believing.
 *
 * Relayed credentials used to be merged into the same list as the ones from
 * agent.yaml and never removed, so a credential withdrawn in the console went
 * on being tried until the process restarted. Revocation was something the
 * console appeared to offer and could not actually do.
 */
class CredentialStoreTest {

    private final DeviceKeypair keypair = newKeypair();
    private final CredentialEnvelope envelope = new CredentialEnvelope(keypair);

    private static DeviceKeypair newKeypair() {
        try {
            Path path = Files.createTempDirectory("credstore").resolve("key.pem");
            return DeviceKeypair.loadOrCreate(path);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** Seals a credential the way the admin browser does. */
    private String seal(String username, String password) throws Exception {
        Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
        cipher.init(Cipher.ENCRYPT_MODE,
                java.security.KeyFactory.getInstance("RSA").generatePublic(
                        new java.security.spec.X509EncodedKeySpec(
                                Base64.getDecoder().decode(keypair.publicKeyBase64()))),
                new OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT));
        String json = "{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}";
        return Base64.getEncoder().encodeToString(cipher.doFinal(json.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }

    @Test
    void offersRelayedAndLocalCredentialsTogether() throws Exception {
        CredentialStore store = new CredentialStore();
        store.setSiteCredentials(List.of(new Credential("local", "from-yaml")));
        store.apply(envelope, Map.of("*", seal("relayed", "from-console")));

        List<Credential> candidates = store.candidates(null);
        assertTrue(candidates.contains(new Credential("relayed", "from-console")));
        assertTrue(candidates.contains(new Credential("local", "from-yaml")));
        // The console is the more recent authority, so it is tried first.
        assertEquals("relayed", candidates.get(0).username());
    }

    @Test
    void prefersACameraSpecificCredential() throws Exception {
        CredentialStore store = new CredentialStore();
        store.apply(envelope, Map.of(
                "*", seal("site", "site-pass"),
                "mac-001122334455", seal("thiscam", "cam-pass")));

        assertEquals("thiscam", store.candidates("mac-001122334455").get(0).username());
        assertEquals("site", store.candidates("other-camera").get(0).username());
    }

    @Test
    void forgetsARelayedCredentialThatIsNoLongerSent() throws Exception {
        // The revocation path. The configuration document is the whole of what
        // the control plane holds, so a scope absent from it has been withdrawn.
        CredentialStore store = new CredentialStore();
        store.apply(envelope, Map.of("*", seal("admin", "old-pass")));
        assertEquals(1, store.candidates(null).size());

        store.apply(envelope, Map.of("*", seal("admin", "new-pass")));
        assertEquals(List.of(new Credential("admin", "new-pass")), store.candidates(null));
    }

    @Test
    void anEmptyDocumentWithdrawsEverythingRelayed() throws Exception {
        CredentialStore store = new CredentialStore();
        store.apply(envelope, Map.of(
                "*", seal("admin", "secret"),
                "mac-001122334455", seal("cam", "secret")));
        assertEquals(2, store.size());

        store.apply(envelope, Map.of());
        assertTrue(store.candidates("mac-001122334455").isEmpty(),
                "a withdrawn credential must not survive the fetch that withdrew it");
        assertEquals(0, store.size());
    }

    @Test
    void withdrawingRelayedCredentialsLeavesTheConfigFilesOwnAlone() throws Exception {
        // agent.yaml is the operator's, not the console's, and a revocation
        // upstream must not silently disarm a locally configured camera.
        CredentialStore store = new CredentialStore();
        store.setSiteCredentials(List.of(new Credential("local", "from-yaml")));
        store.apply(envelope, Map.of("*", seal("relayed", "from-console")));
        assertEquals(2, store.size());

        store.apply(envelope, Map.of());
        assertEquals(List.of(new Credential("local", "from-yaml")), store.candidates(null));
    }

    @Test
    void aCredentialSealedForAnotherDeviceIsDroppedRatherThanThrown() throws Exception {
        // Routine after re-provisioning: the admin encrypted against the key
        // the agent had before it was re-issued.
        CredentialStore store = new CredentialStore();
        store.apply(envelope, Map.of("*", Base64.getEncoder().encodeToString(new byte[256])));
        assertTrue(store.candidates(null).isEmpty());
    }
}
