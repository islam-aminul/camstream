package online.camstream.agent.update;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * A bundle is trusted because it was signed, not because its URL looked right.
 *
 * The update instruction is already authenticated — it arrives on a topic only
 * the control plane may publish to — but that says nothing about the bytes at
 * the URL it names. The only check today is `isTrustedSource`: HTTPS, a host
 * ending .amazonaws.com containing "s3". That is the shape of a URL.
 *
 * These exercise the verdicts rather than the plumbing, because the verdicts
 * are where the security lives and each one is a decision somebody could get
 * wrong in an obvious direction:
 *
 *   - accepting a bad signature is the whole failure
 *   - refusing an unsigned package too early strands the fleet mid-rollout
 *   - accepting a signature a build cannot check makes signing opt-out by
 *     accident, which is the failure that would never be noticed
 *
 * Keys are generated per-test rather than committed, so nothing here depends on
 * a fixture that could quietly become the real key.
 */
class PackageSignatureTest {

    private static KeyPair p256() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    private static String sign(Path file, KeyPair key) throws Exception {
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(key.getPrivate());
        signer.update(Files.readAllBytes(file));
        return Base64.getEncoder().encodeToString(signer.sign());
    }

    private static Path bundle(Path dir, String content) throws Exception {
        Path file = dir.resolve("bundle.tar.gz");
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return file;
    }

    @Test
    @DisplayName("no signature is accepted while the fleet is migrating")
    void unsignedIsAccepted(@TempDir Path dir) throws Exception {
        // The first half of the rollout ships a build that can verify but does
        // not insist. Refusing here would strand every agent still running the
        // build before this one - and the update that would fix them is the
        // one they would refuse.
        Path file = bundle(dir, "a bundle");
        assertEquals(PackageSignature.Verdict.UNSIGNED, PackageSignature.verify(file, null));
        assertEquals(PackageSignature.Verdict.UNSIGNED, PackageSignature.verify(file, "   "));
    }

    @Test
    @DisplayName("a signature this build cannot check is refused, not waved through")
    void unverifiableIsRefused(@TempDir Path dir) throws Exception {
        // No keys are compiled into the test classpath, so this is a build that
        // carries none. Accepting would make the mechanism opt-out by accident:
        // ship one build without keys and it silently stops checking, which is
        // exactly the failure nobody would notice.
        Path file = bundle(dir, "a bundle");
        String signature = sign(file, p256());
        assertEquals(PackageSignature.Verdict.UNVERIFIABLE, PackageSignature.verify(file, signature));
    }

    @Test
    @DisplayName("rubbish in the signature field is refused rather than thrown")
    void malformedIsRefused(@TempDir Path dir) throws Exception {
        // An exception here would propagate into the update path and be caught
        // as a failed update, which is the right outcome by the wrong route -
        // and it would say nothing useful about why.
        Path file = bundle(dir, "a bundle");
        assertNotEquals(PackageSignature.Verdict.TRUSTED,
                PackageSignature.verify(file, "not base64 !!!"));
    }

    @Test
    @DisplayName("a signature is over the bundle, so changing a byte breaks it")
    void signatureCoversTheBytes(@TempDir Path dir) throws Exception {
        // The property the whole design rests on. Signing the jar inside the
        // archive instead would leave the archive itself unauthenticated, and
        // the archive is what the hand-rolled tar reader parses.
        KeyPair key = p256();
        Path file = bundle(dir, "the real bundle");
        String signature = sign(file, key);

        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(key.getPublic());
        verifier.update(Files.readAllBytes(file));
        org.junit.jupiter.api.Assertions.assertTrue(
                verifier.verify(Base64.getDecoder().decode(signature)),
                "the signature should verify against the bytes it was made over");

        Files.writeString(file, "the tampered bundle", StandardCharsets.UTF_8);
        Signature after = Signature.getInstance("SHA256withECDSA");
        after.initVerify(key.getPublic());
        after.update(Files.readAllBytes(file));
        org.junit.jupiter.api.Assertions.assertFalse(
                after.verify(Base64.getDecoder().decode(signature)),
                "a changed bundle must not verify");
    }

    @Test
    @DisplayName("a signature from a trusted key is accepted")
    void trustedKeyIsAccepted(@TempDir Path dir) throws Exception {
        KeyPair key = p256();
        Path file = bundle(dir, "a bundle");
        assertEquals(PackageSignature.Verdict.TRUSTED,
                PackageSignature.verify(file, sign(file, key), java.util.List.of(key.getPublic())));
    }

    @Test
    @DisplayName("a signature from any trusted key is accepted, so rotation is possible")
    void anyTrustedKeyIsAccepted(@TempDir Path dir) throws Exception {
        // Rotation needs the fleet to trust the new key before anything is
        // signed with it, so the set has to be a set and not a slot.
        KeyPair retiring = p256();
        KeyPair incoming = p256();
        Path file = bundle(dir, "a bundle");
        assertEquals(PackageSignature.Verdict.TRUSTED,
                PackageSignature.verify(file, sign(file, incoming),
                        java.util.List.of(retiring.getPublic(), incoming.getPublic())));
    }

    @Test
    @DisplayName("a signature from a key we do not trust is refused")
    void untrustedKeyIsRefused(@TempDir Path dir) throws Exception {
        // The attack this exists to stop: a well-formed signature made by
        // somebody else's key. Nothing about it looks wrong until it is checked.
        KeyPair ours = p256();
        KeyPair theirs = p256();
        Path file = bundle(dir, "a bundle");
        assertEquals(PackageSignature.Verdict.REJECTED,
                PackageSignature.verify(file, sign(file, theirs), java.util.List.of(ours.getPublic())));
    }

    @Test
    @DisplayName("a tampered bundle is refused even with a real signature")
    void tamperedBundleIsRefused(@TempDir Path dir) throws Exception {
        KeyPair key = p256();
        Path file = bundle(dir, "the real bundle");
        String signature = sign(file, key);
        Files.writeString(file, "the tampered bundle", StandardCharsets.UTF_8);
        assertEquals(PackageSignature.Verdict.REJECTED,
                PackageSignature.verify(file, signature, java.util.List.of(key.getPublic())));
    }

    @Test
    @DisplayName("a build with no keys compiled in trusts nothing")
    void noKeysMeansNoTrust() {
        // Not an error state during the rollout - it is what every agent looks
        // like before the first signed build reaches it - but it must read as
        // "trusts nothing", never as "trusts anything".
        assertEquals(0, PackageSignature.trustedKeys().size());
    }
}
