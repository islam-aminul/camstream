package online.camstream.agent.update;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Where a downloaded build is put down before the restart that installs it.
 *
 * Beside the installed jar is the obvious answer and is what the Windows
 * launcher looks for. On a hardened systemd unit it is impossible: the service
 * runs as an unprivileged user, and ProtectSystem=strict makes the whole
 * filesystem read-only apart from the state directory, so the installation
 * directory is unwritable twice over.
 *
 * The failure was silent and late. The update downloaded, extracted the jar,
 * verified its manifest — and then could not write the file. Keeping the
 * program directory unwritable by the service is worth more than the simpler
 * path, so the unit installs the staged jar as root instead.
 */
class StagingPathTest {

    private static Updater updater(Path installedJar, Path stateDir) {
        return new Updater(installedJar, stateDir);
    }

    @Test
    @DisplayName("stages beside the jar when that directory can be written")
    void besideTheJarWhenWritable(@TempDir Path dir) throws Exception {
        Path install = Files.createDirectories(dir.resolve("opt"));
        Path state = Files.createDirectories(dir.resolve("state"));
        Path jar = install.resolve("camstream-agent.jar");

        assertEquals(install.resolve("camstream-agent.jar.new"),
                updater(jar, state).stagingPath(),
                "the Windows launcher looks for the staged jar beside the installed one");
    }

    @Test
    @DisplayName("falls back to the state directory when the installation is read-only")
    void stateDirWhenNotWritable(@TempDir Path dir) throws Exception {
        Path install = Files.createDirectories(dir.resolve("opt"));
        Path state = Files.createDirectories(dir.resolve("state"));
        Path jar = install.resolve("camstream-agent.jar");

        install.toFile().setWritable(false, false);
        // Windows and a test running as root both ignore the bit; there is
        // nothing to assert on those, and the case above already covers the
        // writable path.
        assumeTrue(!Files.isWritable(install), "could not make the directory read-only here");

        assertEquals(state.resolve("camstream-agent.jar.new"),
                updater(jar, state).stagingPath(),
                "the state directory is the one path a hardened unit can write");
        install.toFile().setWritable(true, true);
    }

    @Test
    @DisplayName("the shipped unit installs whichever location was used, as root")
    void unitCoversBothLocations() throws Exception {
        // The two halves have to agree, and they are written in different
        // languages in different files, so nothing else would catch a drift.
        Path unit = Path.of("..", "packaging", "linux", "camstream-agent.service");
        assumeTrue(Files.exists(unit), "unit file not present in this checkout");
        String text = Files.readString(unit);

        assertTrue(text.contains("ExecStartPre=+"),
                "the swap must run as root, or it cannot replace a root-owned jar");
        assertTrue(text.contains("/var/lib/camstream/camstream-agent.jar.new"),
                "the unit must look where a hardened agent is able to stage");
        assertTrue(text.contains("\"$j.new\""),
                "and must still honour a jar staged beside the installed one");
        assertTrue(text.contains("cp -f \"$j\" \"$j.previous\""),
                "the previous build is what a failed upgrade falls back to");
    }
}
