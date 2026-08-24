package online.camstream.agent.credentials;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Set;

/**
 * The keypair that lets camera credentials pass through the cloud without the
 * cloud being able to read them.
 *
 * Generated on first run and never transmitted. Only the public half is
 * published, via the heartbeat; the admin UI encrypts against it in the
 * browser, so plaintext credentials exist only there and here.
 *
 * Deliberately separate from the device's IoT/TLS certificate. Reusing a key
 * across TLS and data encryption couples two very different lifetimes — a
 * certificate rotation should not silently make every stored credential
 * undecryptable, and vice versa.
 */
public final class DeviceKeypair {

    private static final Logger log = LoggerFactory.getLogger(DeviceKeypair.class);
    private static final int KEY_SIZE = 2048;

    private final KeyPair keyPair;

    private DeviceKeypair(KeyPair keyPair) {
        this.keyPair = keyPair;
    }

    /** Loads the keypair at {@code path}, generating and persisting one if absent. */
    public static DeviceKeypair loadOrCreate(Path path) {
        try {
            if (Files.exists(path)) {
                return new DeviceKeypair(read(path));
            }
            log.info("generating device credential keypair at {}", path);
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(KEY_SIZE);
            KeyPair generated = generator.generateKeyPair();
            write(path, generated);
            return new DeviceKeypair(generated);
        } catch (Exception e) {
            throw new IllegalStateException("Could not load or create the device keypair at " + path, e);
        }
    }

    private static KeyPair read(Path path) throws Exception {
        String pem = Files.readString(path)
                .replaceAll("-----(BEGIN|END) PRIVATE KEY-----", "")
                .replaceAll("\\s", "");
        byte[] der = Base64.getDecoder().decode(pem);
        KeyFactory factory = KeyFactory.getInstance("RSA");
        PrivateKey privateKey = factory.generatePrivate(new PKCS8EncodedKeySpec(der));

        // Recover the public half from the private key's modulus and exponent.
        java.security.interfaces.RSAPrivateCrtKey crt = (java.security.interfaces.RSAPrivateCrtKey) privateKey;
        PublicKey publicKey = factory.generatePublic(
                new java.security.spec.RSAPublicKeySpec(crt.getModulus(), crt.getPublicExponent()));
        return new KeyPair(publicKey, privateKey);
    }

    private static void write(Path path, KeyPair keyPair) throws Exception {
        if (path.getParent() != null) {
            Files.createDirectories(path.getParent());
        }
        String pem = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder(64, new byte[] {'\n'})
                        .encodeToString(keyPair.getPrivate().getEncoded())
                + "\n-----END PRIVATE KEY-----\n";
        Files.writeString(path, pem);
        try {
            Files.setPosixFilePermissions(path, Set.of(
                    PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
        } catch (UnsupportedOperationException e) {
            // Windows: ACL inheritance from the install directory applies instead.
            log.debug("POSIX permissions unavailable on this platform");
        }
    }

    /** Base64 SPKI, as published in the heartbeat for the admin UI to import. */
    public String publicKeyBase64() {
        return Base64.getEncoder().encodeToString(keyPair.getPublic().getEncoded());
    }

    PrivateKey privateKey() {
        return keyPair.getPrivate();
    }
}
