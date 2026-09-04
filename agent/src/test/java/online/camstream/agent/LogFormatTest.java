package online.camstream.agent;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The agent's log carries a time on every line.
 *
 * A log without one cannot do the job an agent log exists for. These files are
 * read afterwards, by somebody asking when a camera stopped, whether a restart
 * came before or after a network change, or how long a sweep took. Without a
 * time the only ordering available is "further down the file", and correlating
 * with the console, with CloudWatch, or with a customer saying "around four
 * o'clock" is guesswork.
 *
 * Configured in a resource rather than the launcher's -D flags so every way of
 * starting the agent gets the same log - the Windows service, the systemd
 * unit, and an engineer running the jar by hand, which is the case where it
 * matters most and the one a launcher flag would have missed.
 */
class LogFormatTest {

    private static Properties shipped() throws Exception {
        try (InputStream in = LogFormatTest.class.getResourceAsStream("/simplelogger.properties")) {
            assertNotNull(in, "simplelogger.properties must ship on the classpath");
            Properties props = new Properties();
            props.load(in);
            return props;
        }
    }

    @Test
    @DisplayName("every line is dated")
    void datesEveryLine() throws Exception {
        Properties props = shipped();
        assertEquals("true", props.getProperty("org.slf4j.simpleLogger.showDateTime"),
                "without this slf4j-simple prints no time at all");
    }

    @Test
    @DisplayName("the pattern is a real one, and carries the offset")
    void patternIsUsable() throws Exception {
        String pattern = shipped().getProperty("org.slf4j.simpleLogger.dateTimeFormat");
        assertNotNull(pattern, "a blank pattern silently degrades to milliseconds since start-up");

        // slf4j-simple hands this straight to SimpleDateFormat and falls back
        // to millis-since-start if it throws, so an unusable pattern would
        // leave no timestamp and no complaint.
        SimpleDateFormat format = assertDoesNotThrow(() -> new SimpleDateFormat(pattern));
        String rendered = format.format(new Date());

        assertTrue(rendered.matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}.+"),
                "expected a dated, sub-second timestamp, got: " + rendered);
        // An estate spans timezones; a bare local time from an unknown one is
        // not a time. "Z" or "+05:30" - either way the offset has to be there.
        assertTrue(rendered.matches(".*(Z|[+-]\\d{2}:?\\d{2})$"),
                "the timestamp should name its offset, got: " + rendered);
    }

    @Test
    @DisplayName("the SDK cannot drown out the agent's own lines")
    void sdkIsQuiet() throws Exception {
        // At debug the AWS SDK prints a canonical request per signed call,
        // which is what buried the agent's own logging the last time this was
        // turned up to chase a fault.
        assertEquals("warn", shipped().getProperty("org.slf4j.simpleLogger.log.software.amazon"));
    }

    @Test
    @DisplayName("the log is UTF-8 even when the host's encoding is not")
    void writesUtf8() throws Exception {
        // Java 21 defaults file.encoding to UTF-8 but leaves the console
        // streams on the platform's encoding, and slf4j-simple logs to
        // System.err. On Windows that made the log cp1252 - an em-dash written
        // as the single byte 0x97, so the file was not decodable as UTF-8 on
        // exactly the lines that explain a fault.
        //
        // This has to run in its own JVM. Surefire replaces System.err with a
        // stream of its own before any test runs, so asking the current process
        // measures the test harness and passes with the fix deleted - which is
        // what the first version of this test did.
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        Process probe = new ProcessBuilder(
                java,
                "-cp", System.getProperty("java.class.path"),
                // The condition being reproduced: a host whose native encoding
                // is not UTF-8. Without the fix the streams inherit this.
                "-Dstdout.encoding=windows-1252",
                "-Dstderr.encoding=windows-1252",
                EncodingProbe.class.getName())
                .redirectErrorStream(false)
                .start();

        String reported = new String(probe.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        assertTrue(probe.waitFor(60, TimeUnit.SECONDS), "the probe JVM should exit promptly");
        assertEquals(0, probe.exitValue(), "probe failed: " + reported);

        // Loading Main runs the static block that installs the streams. It is a
        // static block rather than the first line of main() because the logger
        // is a static field, created at class initialisation - by the time
        // main() is entered it is already too late.
        assertEquals("UTF-8 UTF-8", reported,
                "initialising Main should leave both streams UTF-8, got: " + reported);
    }
}
