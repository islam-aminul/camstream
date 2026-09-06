package online.camstream.agent.update;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Drives the shipped Updater on a machine that is running it.
 *
 * Not a JUnit test, and deliberately not one — it has a {@code main} so that it
 * can be pointed at an *installed* jar rather than at the one the build just
 * produced. Everything else here is checked against freshly compiled classes,
 * which cannot answer the question this exists for: whether the artifact that
 * actually reached the box refuses what it should. A key resource can be lost
 * in packaging, and the symptom of that is nothing at all until a release.
 *
 * It writes only under its own temporary directory, and talks to no network,
 * no MQTT topic and not to the running service. Safe to run on a live agent.
 *
 * <pre>
 *   mvn -q test-compile
 *   scp target/test-classes/online/camstream/agent/update/OnDeviceCheck.class \
 *       box:~/check/online/camstream/agent/update/
 *   scp dist/camstream-agent-&lt;version&gt;-linux.tar.gz box:~/check/real.tar.gz
 *   # the signature is object metadata on the published bundle:
 *   aws s3api head-object --bucket &lt;live bucket&gt; \
 *       --key downloads/camstream-agent-&lt;version&gt;-linux.tar.gz \
 *       --query Metadata.signature --output text
 *   ssh box 'cd ~/check &amp;&amp; java -cp /opt/camstream/camstream-agent.jar:. \
 *       online.camstream.agent.update.OnDeviceCheck real.tar.gz &lt;signature&gt;'
 * </pre>
 *
 * Worth running after a key rotation, which is the one change that can strand
 * a fleet quietly: an agent trusting only the retired key keeps working until
 * the first bundle signed with the new one, and then refuses every update with
 * no way to send it a fix.
 *
 * Takes the real published bundle and its published signature, and exits
 * non-zero if any check fails.
 */
public final class OnDeviceCheck {

    private static int failures = 0;

    public static void main(String[] args) throws Exception {
        Path realBundle = Path.of(args[0]);
        String realSignature = args[1];

        Path root = Files.createTempDirectory("sigcheck-");
        System.out.println("agent jar: " + Updater.class.getProtectionDomain()
                .getCodeSource().getLocation());
        System.out.println("keys compiled in: " + PackageSignature.trustedKeys().size());
        System.out.println();

        // The positive control first. If the shipped key cannot verify the
        // bundle this machine is running, everything below is meaningless -
        // a build that refuses everything would pass every negative check.
        check("the real published bundle is TRUSTED",
                PackageSignature.Verdict.TRUSTED,
                PackageSignature.verify(realBundle, realSignature));

        check("no signature is UNSIGNED",
                PackageSignature.Verdict.UNSIGNED,
                PackageSignature.verify(realBundle, null));

        // A signature that is well formed and made by a key nobody trusts:
        // the shape of the actual attack.
        KeyPair theirs = keyPair();
        check("a foreign signature is REJECTED",
                PackageSignature.Verdict.REJECTED,
                PackageSignature.verify(realBundle, sign(realBundle, theirs)));

        // The real signature over bytes that are not the real bytes.
        Path tampered = root.resolve("tampered.tar.gz");
        byte[] bytes = Files.readAllBytes(realBundle);
        bytes[bytes.length / 2] ^= 0x01;
        Files.write(tampered, bytes);
        check("one flipped bit is REJECTED",
                PackageSignature.Verdict.REJECTED,
                PackageSignature.verify(tampered, realSignature));

        System.out.println();

        // And now the decision, not the classification: does install() act on
        // it? A verdict nothing reads would be a mechanism that is switched
        // off, and would look exactly like this from the log.
        installs("an unsigned bundle", root.resolve("a"), bundle(root, "a"), null, false);
        installs("a foreign-signed bundle", root.resolve("b"), bundle(root, "b"),
                sign(bundle(root, "b"), theirs), false);

        System.out.println();
        System.out.println(failures == 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED");
        System.exit(failures == 0 ? 0 : 1);
    }

    /** Runs the real install path and reports whether anything was staged. */
    private static void installs(String what, Path home, Path bundle, String signature,
                                 boolean expectInstalled) throws Exception {
        Path installDir = Files.createDirectories(home.resolve("opt"));
        Path state = Files.createDirectories(home.resolve("state"));
        Path work = Files.createDirectories(home.resolve("work"));
        AtomicInteger exits = new AtomicInteger();

        Updater updater = new Updater(installDir.resolve("camstream-agent.jar"),
                state.resolve("installed-build"), null, exits::incrementAndGet);
        updater.install(bundle, work, "9.9.9", "some-etag", signature);

        boolean staged = Files.exists(installDir.resolve("camstream-agent.jar.new"));
        boolean recorded = Files.exists(state.resolve("installed-build"));
        boolean ok = staged == expectInstalled && (exits.get() > 0) == expectInstalled && !recorded;

        System.out.printf("%-32s staged=%-5s exited=%-5s recorded=%-5s  %s%n",
                what, staged, exits.get() > 0, recorded, ok ? "OK" : "FAILED");
        if (!ok) {
            failures++;
        }
    }

    private static void check(String what, PackageSignature.Verdict expected,
                              PackageSignature.Verdict actual) {
        boolean ok = expected == actual;
        System.out.printf("%-36s %-13s %s%n", what, actual, ok ? "OK" : "FAILED, wanted " + expected);
        if (!ok) {
            failures++;
        }
    }

    private static Path bundle(Path dir, String name) throws Exception {
        Path bundle = dir.resolve(name + ".zip");
        if (Files.exists(bundle)) {
            return bundle;
        }
        Files.createDirectories(dir);
        ByteArrayOutputStream jar = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(jar)) {
            zip.putNextEntry(new ZipEntry("META-INF/MANIFEST.MF"));
            zip.write("Manifest-Version: 1.0\nMain-Class: x.Main\n".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(bundle))) {
            zip.putNextEntry(new ZipEntry("camstream-agent.jar"));
            zip.write(jar.toByteArray());
            zip.closeEntry();
        }
        return bundle;
    }

    private static KeyPair keyPair() throws Exception {
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
}
