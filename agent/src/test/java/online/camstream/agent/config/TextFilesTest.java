package online.camstream.agent.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import online.camstream.agent.provisioning.IdentityFile;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Files written on Windows arrive with a byte-order mark, and both parsers the
 * agent uses reject one.
 *
 * This crash-looped a real install. PowerShell 5.1's `Set-Content -Encoding
 * UTF8` writes UTF-8 with a BOM - PowerShell 7's does not - so identity.json
 * arrived with three bytes in front of it and Jackson failed on the first
 * character, naming a code point nobody had typed. The service restarted every
 * ten seconds forever.
 *
 * The installer no longer writes one. The agent no longer minds if something
 * else does, which is the half that keeps working when an operator edits the
 * config in Notepad.
 */
class TextFilesTest {

    private static final String BOM = "\uFEFF";

    @Test
    @DisplayName("strips a byte-order mark from the front")
    void stripsLeadingBom() {
        assertEquals("{}", TextFiles.stripBom(BOM + "{}"));
    }

    @Test
    @DisplayName("leaves a file that has none alone")
    void leavesCleanTextAlone() {
        assertEquals("{}", TextFiles.stripBom("{}"));
        assertEquals("", TextFiles.stripBom(""));
    }

    @Test
    @DisplayName("keeps a U+FEFF that is not at the front")
    void keepsAnInteriorZeroWidthSpace() {
        // Anywhere but the first character it is a zero-width no-break space
        // somebody meant, and dropping it would corrupt the value it sits in.
        assertEquals("a" + BOM + "b", TextFiles.stripBom("a" + BOM + "b"));
    }

    @Test
    @DisplayName("an identity file written by Windows still loads")
    void identityWithBomLoads(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("identity.json");
        String json = """
                {"thingName":"acme--hq-north--gate-house","region":"ap-south-1",
                 "bucket":"a-bucket","apiInvokeUrl":"https://example.invalid",
                 "iotDataEndpoint":"data.invalid","iotCredentialsEndpoint":"creds.invalid"}""";
        Files.write(file, (BOM + json).getBytes(StandardCharsets.UTF_8));

        IdentityFile identity = assertDoesNotThrow(() -> IdentityFile.load(file));
        assertEquals("acme--hq-north--gate-house", identity.thingName);
    }

    @Test
    @DisplayName("a config written by Windows still loads")
    void configWithBomLoads(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("agent.yaml");
        Files.write(file, (BOM + "stateDir: C:/ProgramData/CamStream\n")
                .getBytes(StandardCharsets.UTF_8));

        AgentConfig config = assertDoesNotThrow(() -> AgentConfig.loadRaw(file));
        assertEquals("C:/ProgramData/CamStream", config.stateDir);
    }

    @Test
    @DisplayName("JSON really does reject one, so this test is not theatre")
    void aBomGenuinelyBreaksJson() {
        // Guards the guard: if Jackson ever tolerated a BOM the tests above
        // would pass for the wrong reason.
        //
        // And it names which parser. YAML accepts a BOM quite happily, so the
        // configuration file was never the problem - it was identity.json, and
        // only identity.json, which is why the agent got as far as reading its
        // configuration before it died. Asserting that YAML breaks too would
        // have been a test of something that was never true.
        assertThrows(Exception.class,
                () -> new ObjectMapper().readTree(BOM + "{}"),
                "JSON no longer breaks on a BOM; this guard is obsolete");

        assertDoesNotThrow(() -> new ObjectMapper(new YAMLFactory())
                .readValue(BOM + "stateDir: x", AgentConfig.class));
    }
}
