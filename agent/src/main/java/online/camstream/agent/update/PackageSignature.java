package online.camstream.agent.update;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Whether a downloaded bundle was produced by us.
 *
 * The update instruction is already authenticated — it arrives on an MQTT topic
 * only the control plane may publish to. What it does not establish is anything
 * about the bytes at the URL it names. Today the only check is that the URL
 * looks like S3 over HTTPS, which is the shape of a URL and not evidence.
 *
 * So the bundle is signed at publish time with a KMS asymmetric key, and
 * verified here before the archive is opened. That ordering is the point: the
 * tar reader below is hand-rolled, and a build that has not decided to trust
 * these bytes should not be parsing them.
 *
 * The public keys are compiled in, as a set. Fetching them would be circular —
 * a key delivered over the channel being authenticated authenticates nothing —
 * and a set rather than one because rotating means the fleet must trust the new
 * key before anything is signed with it.
 *
 * ECDSA over P-256: KMS's ECDSA_SHA_256 emits the DER encoding that
 * SHA256withECDSA expects, so this needs nothing that is not already in the
 * JDK.
 */
public final class PackageSignature {

    private static final Logger log = LoggerFactory.getLogger(PackageSignature.class);

    /** Where the trusted public keys live in the jar. */
    static final String KEY_RESOURCE = "/signing-keys.pem";

    private static final String ALGORITHM = "SHA256withECDSA";

    private PackageSignature() {
    }

    /** What a verification attempt concluded, so callers can say why. */
    public enum Verdict {
        /** The bundle carries a signature made by a key this build trusts. */
        TRUSTED,
        /** No signature was offered. Accepted while the fleet is being migrated. */
        UNSIGNED,
        /** A signature was offered and no trusted key accepts it. */
        REJECTED,
        /** A signature was offered and this build carries no keys to check it. */
        UNVERIFIABLE,
    }

    /**
     * Checks a bundle against the keys this build trusts.
     *
     * <p>A signature that is present and wrong is {@link Verdict#REJECTED}: the
     * only reasons for it are a corrupted download, a bundle from somewhere
     * else, or somebody trying something. None of them is an update.
     *
     * <p>A signature that is present and cannot be checked at all is
     * {@link Verdict#UNVERIFIABLE} rather than accepted. A build that carries
     * no keys cannot tell a good signature from a bad one, and treating that as
     * "fine" would make the whole mechanism opt-out by accident.
     */
    public static Verdict verify(Path bundle, String base64Signature) {
        return verify(bundle, base64Signature, trustedKeys());
    }

    /**
     * The same decision against an explicit key set.
     *
     * Exists so the happy path can be tested. Compiling a key into the test
     * classpath would work once and then quietly answer for every other test in
     * the file - including the one asserting that a build with no keys trusts
     * nothing, which is the assertion that keeps signing from becoming opt-out.
     */
    static Verdict verify(Path bundle, String base64Signature, List<PublicKey> trusted) {
        if (base64Signature == null || base64Signature.isBlank()) {
            return Verdict.UNSIGNED;
        }
        if (trusted.isEmpty()) {
            log.error("bundle is signed but this build carries no signing keys; refusing it");
            return Verdict.UNVERIFIABLE;
        }
        byte[] signature;
        try {
            signature = Base64.getDecoder().decode(base64Signature.trim());
        } catch (IllegalArgumentException e) {
            log.error("bundle signature is not base64; refusing it");
            return Verdict.REJECTED;
        }

        for (PublicKey key : trusted) {
            if (matches(bundle, signature, key)) {
                return Verdict.TRUSTED;
            }
        }
        log.error("bundle signature matches none of the {} key(s) this build trusts", trusted.size());
        return Verdict.REJECTED;
    }

    private static boolean matches(Path bundle, byte[] signature, PublicKey key) {
        try (InputStream in = Files.newInputStream(bundle)) {
            Signature verifier = Signature.getInstance(ALGORITHM);
            verifier.initVerify(key);
            // Streamed rather than read whole: a bundle is thirty megabytes and
            // an edge box has been seen at 83% memory.
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                verifier.update(buffer, 0, read);
            }
            return verifier.verify(signature);
        } catch (Exception e) {
            // A key that cannot be used is not a signature that failed; keep
            // trying the others and let the caller see the overall verdict.
            log.debug("could not verify against one key: {}", e.toString());
            return false;
        }
    }

    /**
     * The public keys compiled into this build, newest first.
     *
     * Absent entirely on a build made before signing existed, which is the
     * normal state during the first half of the rollout.
     */
    static List<PublicKey> trustedKeys() {
        List<PublicKey> keys = new ArrayList<>();
        try (InputStream in = PackageSignature.class.getResourceAsStream(KEY_RESOURCE)) {
            if (in == null) {
                return keys;
            }
            String pem = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            for (String block : pem.split("-----BEGIN PUBLIC KEY-----")) {
                int end = block.indexOf("-----END PUBLIC KEY-----");
                if (end < 0) {
                    continue;
                }
                String base64 = block.substring(0, end).replaceAll("\\s", "");
                if (base64.isEmpty()) {
                    continue;
                }
                try {
                    keys.add(KeyFactory.getInstance("EC").generatePublic(
                            new X509EncodedKeySpec(Base64.getDecoder().decode(base64))));
                } catch (Exception e) {
                    // One unreadable key must not disarm the others.
                    log.warn("ignoring an unreadable signing key: {}", e.toString());
                }
            }
        } catch (IOException e) {
            log.warn("could not read signing keys: {}", e.toString());
        }
        return keys;
    }
}
