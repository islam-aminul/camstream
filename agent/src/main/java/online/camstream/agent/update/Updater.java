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
        this.http = http;
        this.exit = exit;
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
            Path staged = extractJar(bundle, work);

            // Beside the installed jar, not over it. The launcher moves it into
            // place before the next JVM starts; nothing here touches a file
            // that something is currently running from.
            Path pending = installedJar.resolveSibling(installedJar.getFileName() + ".new");
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
    private Path extractJar(Path bundle, Path work) throws Exception {
        try (ZipFile zip = new ZipFile(bundle.toFile())) {
            ZipEntry entry = findJar(zip);
            if (entry == null) {
                throw new IllegalStateException("bundle contains no " + JAR_IN_BUNDLE);
            }
            Path staged = work.resolve("camstream-agent.jar");
            try (InputStream in = zip.getInputStream(entry)) {
                Files.copy(in, staged, StandardCopyOption.REPLACE_EXISTING);
            }
            // And the extracted jar must itself be a readable archive with a
            // manifest, or the JVM will refuse it after the swap.
            try (ZipFile check = new ZipFile(staged.toFile())) {
                if (check.getEntry("META-INF/MANIFEST.MF") == null) {
                    throw new IllegalStateException("extracted jar has no manifest");
                }
            }
            return staged;
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
