package online.camstream.agent.update;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * An unsigned package is not installed. This is phase two, and the point of all
 * of it.
 *
 * Phase one shipped an agent that verifies a signature when one is present and
 * accepts a package without one. That is worth almost nothing on its own: an
 * attacker who can cause an update instruction to be issued simply omits the
 * signature field, and the whole mechanism steps politely aside. It existed
 * only so that the fleet could be moved onto a build that *could* check, using
 * the old updater that could not — because the updater that applies an update
 * is always the old one, so the demanding half can never be first.
 *
 * Both agents reported the phase-one build before this was written, which is
 * the only precondition. See docs/signing.md.
 *
 * These drive {@link Updater#install} rather than {@code apply}, because
 * {@code apply} would have to download first and a bundle URL must be HTTPS at
 * an S3 host — not something a test can stand up. Everything after the bytes
 * land is the same code the agent runs.
 */
class UnsignedPackageTest {

    private static KeyPair p256() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return generator.generateKeyPair();
    }

    private static String sign(Path bundle, KeyPair key) throws Exception {
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(key.getPrivate());
        signer.update(Files.readAllBytes(bundle));
        return Base64.getEncoder().encodeToString(signer.sign());
    }

    /** A genuine bundle: a real zip holding a real jar, so nothing else can fail. */
    private static Path bundle(Path dir) throws Exception {
        ByteArrayOutputStream jar = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(jar)) {
            zip.putNextEntry(new ZipEntry("META-INF/MANIFEST.MF"));
            zip.write("Manifest-Version: 1.0\nMain-Class: x.Main\n".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        Path bundle = dir.resolve("bundle.zip");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(bundle))) {
            zip.putNextEntry(new ZipEntry("camstream-agent.jar"));
            zip.write(jar.toByteArray());
            zip.closeEntry();
        }
        return bundle;
    }

    /** An updater whose exit is counted rather than taken. */
    private record Fixture(Updater updater, Path installDir, Path work, AtomicInteger exits) {
        boolean staged() {
            return Files.exists(installDir.resolve("camstream-agent.jar.new"));
        }
    }

    private static Fixture fixture(Path dir) throws Exception {
        Path installDir = Files.createDirectories(dir.resolve("opt"));
        Path state = Files.createDirectories(dir.resolve("state"));
        Path work = Files.createDirectories(dir.resolve("work"));
        AtomicInteger exits = new AtomicInteger();
        Updater updater = new Updater(installDir.resolve("camstream-agent.jar"),
                state.resolve("installed-build"), null, exits::incrementAndGet);
        return new Fixture(updater, installDir, work, exits);
    }

    @Test
    @DisplayName("a package with no signature is refused")
    void unsignedIsRefused(@TempDir Path dir) throws Exception {
        // The failure this whole feature exists to prevent. Note that the
        // bundle is otherwise perfect - it opens, it holds a valid jar, and
        // before this change it would have been installed without complaint.
        Fixture f = fixture(dir);
        f.updater().install(bundle(dir), f.work(), "9.9.9", "etag", null, List.of(p256().getPublic()));

        assertFalse(f.staged(), "an unsigned bundle must not reach the staging path");
        assertEquals(0, f.exits().get(), "and the agent must not restart into it");
    }

    @Test
    @DisplayName("a package signed by somebody else is refused")
    void untrustedSignerIsRefused(@TempDir Path dir) throws Exception {
        Fixture f = fixture(dir);
        Path bundle = bundle(dir);
        f.updater().install(bundle, f.work(), "9.9.9", "etag",
                sign(bundle, p256()), List.of(p256().getPublic()));

        assertFalse(f.staged(), "a signature from an untrusted key must not install");
        assertEquals(0, f.exits().get());
    }

    @Test
    @DisplayName("a package this build has no key for is refused")
    void unverifiableIsRefused(@TempDir Path dir) throws Exception {
        // A build shipped without its key resource. Accepting here would make
        // signing opt-out by accident: one bad packaging run and the fleet
        // stops checking, with nothing in any log to say so.
        Fixture f = fixture(dir);
        Path bundle = bundle(dir);
        f.updater().install(bundle, f.work(), "9.9.9", "etag", sign(bundle, p256()), List.of());

        assertFalse(f.staged());
        assertEquals(0, f.exits().get());
    }

    @Test
    @DisplayName("a properly signed package is still installed")
    void trustedIsInstalled(@TempDir Path dir) throws Exception {
        // The control, and the reason the key set is a parameter at all. Every
        // assertion above is satisfied by an install() that refuses
        // everything, which is the more expensive bug of the two: it would
        // strand the fleet, and it would not be discovered until a release.
        KeyPair key = p256();
        Fixture f = fixture(dir);
        Path bundle = bundle(dir);
        f.updater().install(bundle, f.work(), "9.9.9", "etag",
                sign(bundle, key), List.of(key.getPublic()));

        assertTrue(f.staged(), "a bundle signed by a trusted key must still install");
        assertEquals(1, f.exits().get(), "and the agent must restart into it");
    }

    @Test
    @DisplayName("nothing is refused after the archive has already been opened")
    void refusalHappensBeforeExtraction(@TempDir Path dir) throws Exception {
        // Ordering is the other half of the property. The tar reader is
        // hand-rolled, so a bundle that is refused must never have been parsed
        // - a refusal that happens after extraction protects the installation
        // but not the parser, and the parser is the more interesting target.
        //
        // Asserted by handing install() something that is not an archive at
        // all: if extraction ran first it would throw, and the refusal would
        // arrive as an exception rather than as a quiet return.
        Path notAnArchive = dir.resolve("bundle.zip");
        Files.writeString(notAnArchive, "this will not open");
        Fixture f = fixture(dir);

        f.updater().install(notAnArchive, f.work(), "9.9.9", "etag", null,
                List.of(p256().getPublic()));

        assertFalse(f.staged());
        assertEquals(0, f.exits().get());
    }

    @Test
    @DisplayName("the build marker is not written for a package that was refused")
    void refusedPackageIsNotRecorded(@TempDir Path dir) throws Exception {
        // Worth its own assertion: recording the build would make the agent
        // believe it had taken the update, so it would decline the retry too
        // and sit there silently on the old build for ever.
        Fixture f = fixture(dir);
        f.updater().install(bundle(dir), f.work(), "9.9.9", "etag", null,
                List.of(p256().getPublic()));

        assertFalse(Files.exists(dir.resolve("state").resolve("installed-build")),
                "a refused update must not be remembered as installed");
    }

    @Test
    @DisplayName("the shipped key is the one the agent verifies against by default")
    void productionPathUsesTheShippedKey(@TempDir Path dir) throws Exception {
        // The overload above takes keys; the one the agent calls does not. If
        // they diverged, every test here would pass while the real path
        // trusted nothing - or, worse, trusted a key from somewhere else.
        List<PublicKey> shipped = PackageSignature.trustedKeys();
        assertEquals(1, shipped.size(), "the release key should be compiled in");

        Fixture f = fixture(dir);
        Path bundle = bundle(dir);
        f.updater().install(bundle, f.work(), "9.9.9", "etag", sign(bundle, p256()));
        assertFalse(f.staged(), "the default path must refuse a signature the shipped key rejects");
    }
}
