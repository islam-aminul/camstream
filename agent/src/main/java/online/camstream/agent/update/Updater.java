package online.camstream.agent.update;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.Enumeration;
import java.io.BufferedInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.StandardOpenOption;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Replaces the agent's own program on instruction from the console.
 *
 * The alternative is walking to every site, which stops being possible at the
 * second site. But an agent updating itself is the one operation with no way
 * back: if the new jar does not start, nothing is left running to notice, and
 * the cameras are dark until somebody drives out.
 *
 * It does not replace the running jar, and cannot: Windows holds an open file
 * against renaming, so the move failed with "access denied" and the agent
 * stayed on the old build - correctly, but permanently. The jar is therefore
 * staged as <name>.new and the service launcher swaps it in before the next
 * JVM starts, when nothing has it open. That is also true on Linux, where the
 * move would have worked: one mechanism is easier to reason about than two,
 * and neither of them touches a file something is running from.
 *
 * So the order is: fetch to a temporary file, prove the file is what it claims
 * to be, stage it beside the installed jar, record the build, and exit for the
 * service manager to restart into it.
 */
public final class Updater {

    private static final Logger log = LoggerFactory.getLogger(Updater.class);

    /** The entry every valid bundle contains, and the one that must run after. */
    private static final String JAR_IN_BUNDLE = "camstream-agent.jar";

    private final Path installedJar;
    /**
     * Where the identity of the installed build is remembered.
     *
     * Beside the state rather than the program: an update replaces the jar, so
     * anything recorded next to it would be replaced with it.
     */
    private final Path buildMarker;
    private final Path stateDir;
    private final HttpClient http;
    private final Runnable exit;

    public Updater(Path installedJar, Path stateDir) {
        this(installedJar, stateDir.resolve("installed-build"),
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build(),
                () -> System.exit(SelfUpdate.RESTART_EXIT_CODE));
    }

    Updater(Path installedJar, Path buildMarker, HttpClient http, Runnable exit) {
        this.installedJar = installedJar;
        this.buildMarker = buildMarker;
        this.stateDir = buildMarker.getParent();
        this.http = http;
        this.exit = exit;
    }

    /**
     * Where a downloaded build can actually be put down.
     *
     * Beside the installed jar when that is possible, which is the Windows
     * service and anything running as an administrator, and is what the
     * launcher there already looks for.
     *
     * Otherwise the state directory. A hardened systemd unit runs as an
     * unprivileged user under ProtectSystem=strict, so the installation
     * directory is read-only to it twice over - by ownership and by the
     * sandbox. Staging beside the jar could never have worked there, and the
     * failure was silent: the update downloaded, extracted, verified, and then
     * could not put the file down.
     *
     * Keeping the program directory unwritable by the service is worth more
     * than the simpler path, so the unit installs the staged jar as root
     * before the JVM starts.
     */
    Path stagingPath() {
        Path beside = installedJar.resolveSibling(installedJar.getFileName() + ".new");
        Path directory = installedJar.getParent();
        if (directory != null && Files.isWritable(directory)) {
            return beside;
        }
        return stateDir.resolve(installedJar.getFileName() + ".new");
    }

    /** The build this agent last installed, or null if it has never recorded one. */
    String installedBuild() {
        try {
            return Files.exists(buildMarker) ? Files.readString(buildMarker).trim() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Acts on an update instruction. Returns only if it decided not to.
     *
     * @param runningVersion what this agent is
     * @param wantedVersion  what the console asked for
     * @param wantedBuild    the identity of that bundle, which is what actually
     *                       distinguishes two builds of the same version
     * @param url            a presigned link to the bundle
     */
    public void apply(String runningVersion, String wantedVersion, String wantedBuild, String url) {
        apply(runningVersion, wantedVersion, wantedBuild, url, null);
    }

    /**
     * @param signature base64 of the bundle's signature, or null when the
     *   control plane did not send one. While the fleet is being migrated an
     *   unsigned package is still accepted; a signature that is present and
     *   wrong never is. See {@code docs/signing.md}.
     */
    public void apply(String runningVersion, String wantedVersion, String wantedBuild,
                      String url, String signature) {
        SelfUpdate.Decision decision =
                SelfUpdate.decide(runningVersion, installedBuild(), wantedVersion, wantedBuild, url);
        switch (decision) {
            case ALREADY_CURRENT -> {
                log.info("update to {} ignored: already running it", wantedVersion);
                return;
            }
            case MALFORMED, REFUSED -> {
                log.warn("refusing update instruction for version \"{}\": {}", wantedVersion, decision);
                return;
            }
            case UPDATE -> { /* carry on */ }
        }

        Path work = null;
        try {
            log.info("updating from {} to {}", runningVersion, wantedVersion);
            work = Files.createTempDirectory("camstream-update-");
            Path bundle = work.resolve("bundle.zip");

            download(url, bundle);

            // Before the archive is opened, not after. The tar reader below is
            // hand-rolled, and bytes this build has not decided to trust should
            // not be parsed by it.
            PackageSignature.Verdict verdict = PackageSignature.verify(bundle, signature);
            switch (verdict) {
                case REJECTED, UNVERIFIABLE -> {
                    log.error("refusing update to {}: signature {}", wantedVersion, verdict);
                    return;
                }
                case UNSIGNED -> log.warn(
                        "update to {} is not signed; accepted while the fleet is migrating", wantedVersion);
                case TRUSTED -> log.info("update to {} carries a trusted signature", wantedVersion);
            }

            Path staged = extractJar(bundle, work);

            // Never over the installed jar. The launcher or the unit moves it
            // into place before the next JVM starts; nothing here touches a
            // file that something is currently running from.
            Path pending = stagingPath();
            Files.createDirectories(pending.getParent());
            Files.move(staged, pending, StandardCopyOption.REPLACE_EXISTING);

            // Recorded before the exit. If the agent restarted into the new
            // build and had not recorded it, it would reinstall the same build
            // on every instruction for ever; the other way round it merely
            // declines one update it had already taken.
            if (wantedBuild != null && !wantedBuild.isBlank()) {
                Files.createDirectories(buildMarker.getParent());
                Files.writeString(buildMarker, wantedBuild);
            }

            log.info("staged {} as {}; exiting for the service manager to start it",
                    wantedVersion, pending.getFileName());
            exit.run();
        } catch (Exception e) {
            log.error("update to {} failed, staying on {}: {}", wantedVersion, runningVersion, e.toString());
        } finally {
            deleteQuietly(work);
        }
    }

    private void download(String url, Path into) throws Exception {
        HttpResponse<Path> response = http.send(
                HttpRequest.newBuilder(URI.create(url))
                        .timeout(Duration.ofMinutes(10))
                        .GET().build(),
                HttpResponse.BodyHandlers.ofFile(into));

        if (response.statusCode() != 200) {
            throw new IllegalStateException("bundle download returned HTTP " + response.statusCode());
        }
        long size = Files.size(into);
        if (!SelfUpdate.isPlausibleSize(size)) {
            // A proxy's error page is a few hundred bytes, and unpacking one
            // over the running jar is the outcome with no way back.
            throw new IllegalStateException("bundle is only " + size + " bytes");
        }
    }

    /**
     * Takes the jar out of the bundle, having first proved the bundle opens.
     *
     * Reading the archive is the verification. A truncated or corrupt download
     * fails here, on a temporary file, rather than after it has replaced the
     * program that would have reported the problem.
     */
    Path extractJar(Path bundle, Path work) throws Exception {
        Path staged = work.resolve("camstream-agent.jar");
        if (isGzip(bundle)) {
            extractFromTarGz(bundle, staged);
        } else {
            extractFromZip(bundle, staged);
        }
        // The extracted jar must itself be a readable archive with a manifest,
        // or the JVM will refuse it after the swap.
        try (ZipFile check = new ZipFile(staged.toFile())) {
            if (check.getEntry("META-INF/MANIFEST.MF") == null) {
                throw new IllegalStateException("extracted jar has no manifest");
            }
        }
        return staged;
    }

    /**
     * Which shape of bundle this is, from its first two bytes.
     *
     * Windows ships a .zip and the other platforms a .tar.gz, and this used to
     * assume the former unconditionally - so a remote update on Linux
     * downloaded the right bundle, failed with "zip END header not found", and
     * stayed on the old build. Every agent not on Windows could only be
     * upgraded by walking to it, which is the thing remote update exists to
     * avoid.
     *
     * Sniffed rather than taken from the URL: the URL is presigned and carries
     * a query string, and a redirect could change the extension without
     * changing what arrives.
     */
    private static boolean isGzip(Path bundle) throws IOException {
        try (InputStream in = Files.newInputStream(bundle)) {
            byte[] magic = in.readNBytes(2);
            return magic.length == 2 && (magic[0] & 0xff) == 0x1f && (magic[1] & 0xff) == 0x8b;
        }
    }

    private static void extractFromZip(Path bundle, Path staged) throws Exception {
        try (ZipFile zip = new ZipFile(bundle.toFile())) {
            ZipEntry entry = findJar(zip);
            if (entry == null) {
                throw new IllegalStateException("bundle contains no " + JAR_IN_BUNDLE);
            }
            try (InputStream in = zip.getInputStream(entry)) {
                Files.copy(in, staged, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    /**
     * Reads the jar out of a gzipped tar, without shelling out to tar.
     *
     * The format is simple enough to read directly: 512-byte headers, a name
     * in the first 100 bytes, a size in octal at offset 124, and file content
     * padded to the next 512-byte boundary. Doing it here keeps the code that
     * replaces the program self-contained and testable, rather than depending
     * on a tar binary being present and behaving the same everywhere.
     */
    private static void extractFromTarGz(Path bundle, Path staged) throws Exception {
        try (InputStream in = new GZIPInputStream(
                new BufferedInputStream(Files.newInputStream(bundle)))) {
            byte[] header = new byte[512];
            while (true) {
                if (in.readNBytes(header, 0, 512) != 512) {
                    break;
                }
                String name = tarString(header, 0, 100);
                if (name.isEmpty()) {
                    break;  // Two zero blocks end the archive.
                }
                long size = tarSize(header);
                boolean wanted = name.equals(JAR_IN_BUNDLE) || name.endsWith("/" + JAR_IN_BUNDLE);
                // Type '0' and NUL are regular files; anything else is a
                // directory, a link or an extended header and has no content
                // we want, though it still occupies its padded blocks.
                char type = (char) header[156];
                if (wanted && (type == '0' || type == 0)) {
                    try (OutputStream out = Files.newOutputStream(staged,
                            StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)) {
                        copyExactly(in, out, size);
                    }
                    return;
                }
                skipExactly(in, padded(size));
            }
        }
        throw new IllegalStateException("bundle contains no " + JAR_IN_BUNDLE);
    }

    private static String tarString(byte[] header, int offset, int length) {
        int end = offset;
        while (end < offset + length && header[end] != 0) {
            end++;
        }
        return new String(header, offset, end - offset, StandardCharsets.US_ASCII).trim();
    }

    /** The size field: octal, space or NUL padded. */
    private static long tarSize(byte[] header) {
        String raw = tarString(header, 124, 12);
        return raw.isEmpty() ? 0L : Long.parseLong(raw, 8);
    }

    private static long padded(long size) {
        long remainder = size % 512;
        return remainder == 0 ? size : size + (512 - remainder);
    }

    private static void copyExactly(InputStream in, OutputStream out, long size) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        long left = size;
        while (left > 0) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, left));
            if (read < 0) {
                throw new EOFException("bundle ended inside " + JAR_IN_BUNDLE);
            }
            out.write(buffer, 0, read);
            left -= read;
        }
        skipExactly(in, padded(size) - size);
    }

    private static void skipExactly(InputStream in, long count) throws IOException {
        long left = count;
        while (left > 0) {
            long skipped = in.skip(left);
            if (skipped <= 0) {
                if (in.read() < 0) {
                    return;
                }
                skipped = 1;
            }
            left -= skipped;
        }
    }

    private static ZipEntry findJar(ZipFile zip) {
        Enumeration<? extends ZipEntry> entries = zip.entries();
        while (entries.hasMoreElements()) {
            ZipEntry entry = entries.nextElement();
            String name = entry.getName();
            if (!entry.isDirectory()
                    && (name.equals(JAR_IN_BUNDLE) || name.endsWith("/" + JAR_IN_BUNDLE))) {
                return entry;
            }
        }
        return null;
    }

    private static void deleteQuietly(Path dir) {
        if (dir == null) {
            return;
        }
        try (var walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception ignored) {
                    // A temp file left behind is not worth a second failure.
                }
            });
        } catch (Exception ignored) {
            // As above.
        }
    }
}
