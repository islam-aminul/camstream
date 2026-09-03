package online.camstream.agent.update;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Both shapes of bundle this project ships.
 *
 * Windows gets a .zip and every other platform a .tar.gz, and the updater
 * assumed a zip unconditionally. A remote update on Linux therefore downloaded
 * the correct bundle, failed with "zip END header not found", and stayed on the
 * old build — so every agent that was not on Windows could only be upgraded by
 * walking to it, which is the one thing remote update exists to avoid. It was
 * found the first time the agent was installed on a Raspberry Pi.
 */
class BundleShapeTest {

    /** A minimal but genuine jar: the updater checks for a manifest. */
    private static byte[] jar(String marker) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
            zip.putNextEntry(new ZipEntry("META-INF/MANIFEST.MF"));
            zip.write(("Manifest-Version: 1.0\nMain-Class: " + marker + "\n")
                    .getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        return bytes.toByteArray();
    }

    private static Path zipBundle(Path dir, byte[] jar) throws Exception {
        Path bundle = dir.resolve("bundle.zip");
        try (ZipOutputStream zip = new ZipOutputStream(Files.newOutputStream(bundle))) {
            zip.putNextEntry(new ZipEntry("NOTICE"));
            zip.write("not the jar".getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
            zip.putNextEntry(new ZipEntry("camstream-agent.jar"));
            zip.write(jar);
            zip.closeEntry();
        }
        return bundle;
    }

    /** A real gzipped tar, written by hand so the test does not share the reader's assumptions. */
    private static Path tarGzBundle(Path dir, byte[] jar, String jarPath) throws Exception {
        Path bundle = dir.resolve("bundle.tar.gz");
        try (OutputStream out = new GZIPOutputStream(Files.newOutputStream(bundle))) {
            // A decoy first, so finding the jar means scanning past an entry.
            writeEntry(out, "NOTICE", "not the jar".getBytes(StandardCharsets.UTF_8));
            writeEntry(out, jarPath, jar);
            out.write(new byte[1024]);  // Two zero blocks end the archive.
        }
        return bundle;
    }

    private static void writeEntry(OutputStream out, String name, byte[] content) throws Exception {
        byte[] header = new byte[512];
        byte[] nameBytes = name.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(nameBytes, 0, header, 0, nameBytes.length);
        byte[] size = String.format("%011o ", content.length).getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(size, 0, header, 124, size.length);
        header[156] = '0';
        // The checksum field is spaces while the checksum is computed over it.
        for (int i = 148; i < 156; i++) {
            header[i] = ' ';
        }
        int sum = 0;
        for (byte b : header) {
            sum += b & 0xff;
        }
        byte[] checksum = String.format("%06o", sum).getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(checksum, 0, header, 148, checksum.length);
        header[154] = 0;
        header[155] = ' ';

        out.write(header);
        out.write(content);
        int padding = (512 - (content.length % 512)) % 512;
        out.write(new byte[padding]);
    }

    private static Updater updater(Path dir) {
        return new Updater(dir.resolve("installed.jar"), dir.resolve("state"));
    }

    @Test
    @DisplayName("reads the jar out of a Windows .zip bundle")
    void readsZip(@TempDir Path dir) throws Exception {
        byte[] jar = jar("zip.Main");
        Path staged = updater(dir).extractJar(zipBundle(dir, jar), Files.createDirectories(dir.resolve("w1")));
        assertArrayEquals(jar, Files.readAllBytes(staged));
    }

    @Test
    @DisplayName("reads the jar out of a Linux .tar.gz bundle")
    void readsTarGz(@TempDir Path dir) throws Exception {
        byte[] jar = jar("tar.Main");
        Path staged = updater(dir).extractJar(tarGzBundle(dir, jar, "camstream-agent.jar"),
                Files.createDirectories(dir.resolve("w2")));
        assertArrayEquals(jar, Files.readAllBytes(staged),
                "the bytes staged must be exactly the jar, not a block-padded copy");
    }

    @Test
    @DisplayName("finds the jar inside a directory, which is how the bundles are laid out")
    void readsNestedTarGz(@TempDir Path dir) throws Exception {
        byte[] jar = jar("nested.Main");
        Path staged = updater(dir).extractJar(
                tarGzBundle(dir, jar, "camstream-agent-0.1.0-linux/camstream-agent.jar"),
                Files.createDirectories(dir.resolve("w3")));
        assertArrayEquals(jar, Files.readAllBytes(staged));
    }

    @Test
    @DisplayName("a bundle without the jar is refused rather than staged empty")
    void refusesABundleWithoutTheJar(@TempDir Path dir) throws Exception {
        Path bundle = dir.resolve("empty.tar.gz");
        try (OutputStream out = new GZIPOutputStream(Files.newOutputStream(bundle))) {
            writeEntry(out, "NOTICE", "nothing useful".getBytes(StandardCharsets.UTF_8));
            out.write(new byte[1024]);
        }
        Path work = Files.createDirectories(dir.resolve("w4"));
        assertThrows(Exception.class, () -> updater(dir).extractJar(bundle, work));
    }

    @Test
    @DisplayName("a truncated download fails on the temporary copy, not on the installation")
    void refusesTruncatedDownload(@TempDir Path dir) throws Exception {
        Path bundle = dir.resolve("truncated.tar.gz");
        byte[] whole = Files.readAllBytes(tarGzBundle(dir, jar("x.Main"), "camstream-agent.jar"));
        Files.write(bundle, java.util.Arrays.copyOf(whole, whole.length / 2));
        Path work = Files.createDirectories(dir.resolve("w5"));

        assertThrows(Exception.class, () -> updater(dir).extractJar(bundle, work));
        assertTrue(Files.notExists(dir.resolve("installed.jar")),
                "the installed jar must be untouched by a failed extraction");
    }
}
