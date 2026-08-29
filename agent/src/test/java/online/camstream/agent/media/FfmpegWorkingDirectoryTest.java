package online.camstream.agent.media;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Where ffmpeg is run from, which is not a detail.
 *
 * The initialisation segment is the one output whose name cannot be an
 * absolute path: ffmpeg copies it verbatim into the playlist as the EXT-X-MAP
 * URI, so it has to stay relative for a viewer to resolve it against the
 * stream's own directory. That makes it the one output resolved against the
 * working directory instead.
 *
 * Left unset, that was wherever the service happened to start, so the file
 * landed next to the agent rather than with its segments and was never
 * uploaded. The stream was complete in the bucket and unplayable: the manifest
 * fetched, the segments fetched, and the one 873-byte file that says how to
 * decode them returned 403.
 */
class FfmpegWorkingDirectoryTest {

    @Test
    @DisplayName("ffmpeg runs in the directory its segments are written to")
    void runsInTheOutputDirectory(@TempDir Path outputDir) {
        ProcessBuilder builder = FfmpegHls.processIn(List.of("ffmpeg", "-version"), outputDir);

        assertNotNull(builder.directory(),
                "an unset working directory is inherited from whatever started the agent");
        assertEquals(outputDir.toFile(), builder.directory(),
                "a relative output must resolve next to the segments, not next to the service");
    }
}
