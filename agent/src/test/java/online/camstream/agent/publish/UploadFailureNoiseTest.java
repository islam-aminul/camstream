package online.camstream.agent.publish;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import software.amazon.awssdk.core.exception.SdkClientException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectResponse;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * An outage is one event in the log, not one line per attempt.
 *
 * sync() runs four times a second. Anything that lasts more than a moment is
 * therefore written hundreds of times, all of it true and none of it adding
 * anything after the first line.
 *
 * Measured on a real agent: a fifty-eight second DNS failure produced 145
 * identical `upload failed: ... UnknownHostException` lines. The agent behaved
 * correctly throughout - it retried, and recovered on its own - but the log of
 * the incident was 145 lines of the same sentence, which buries the MQTT
 * interruption that started it and the recovery that ended it.
 *
 * The count is the part worth keeping. "recovered after 145 failure(s)" says
 * both that it broke and how badly, on one line, at the moment somebody can act
 * on it.
 */
class UploadFailureNoiseTest {

    /** Fails on demand, so an outage can be started and ended. */
    private static final class FlakyS3 implements S3Client {
        volatile RuntimeException failure;
        int puts;

        @Override
        public PutObjectResponse putObject(PutObjectRequest request, RequestBody body) {
            puts++;
            if (failure != null) {
                throw failure;
            }
            return PutObjectResponse.builder().build();
        }

        @Override
        public String serviceName() {
            return "s3";
        }

        @Override
        public void close() {
        }
    }

    private PrintStream realErr;
    private ByteArrayOutputStream captured;

    @BeforeEach
    void captureLog() {
        realErr = System.err;
        captured = new ByteArrayOutputStream();
        System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
    }

    @AfterEach
    void restoreLog() {
        System.setErr(realErr);
    }

    private static void writeSegment(Path dir, int n) throws IOException {
        Files.writeString(dir.resolve(String.format("abc_%06d.m4s", n)), "segment " + n);
    }

    private long count(String log, String needle) {
        return log.lines().filter(line -> line.contains(needle)).count();
    }

    @Test
    @DisplayName("a sustained outage is one line, and recovery says how bad it was")
    void reportsOnceAndCounts(@TempDir Path dir) throws Exception {
        FlakyS3 s3 = new FlakyS3();
        HlsPublisher publisher = new HlsPublisher(s3, "bucket", "live/cam/sub", dir, "cam/sub", 4);

        s3.failure = SdkClientException.create("Received an UnknownHostException");
        // Forty ticks is ten seconds of real time; the outage that prompted
        // this lasted nearly six times that.
        for (int i = 0; i < 40; i++) {
            writeSegment(dir, i);
            publisher.sync();
        }

        String duringOutage = captured.toString(StandardCharsets.UTF_8);
        assertEquals(1, count(duringOutage, "upload failed"),
                "an outage should be reported once, log was:\n" + duringOutage);

        s3.failure = null;
        writeSegment(dir, 100);
        publisher.sync();

        String afterRecovery = captured.toString(StandardCharsets.UTF_8);
        assertTrue(afterRecovery.contains("uploads recovered after"),
                "recovery should be said out loud, log was:\n" + afterRecovery);
        // The number matters more than the word: it is the only record of how
        // long the agent was unable to publish.
        assertTrue(afterRecovery.matches("(?s).*recovered after [1-9]\\d+ failure\\(s\\).*"),
                "recovery should carry the failure count, log was:\n" + afterRecovery);
    }

    @Test
    @DisplayName("a different fault mid-outage is still reported")
    void adifferentFaultIsANewEvent(@TempDir Path dir) throws Exception {
        // Suppressing by "already failing" would hide a fault changing
        // underneath - a name that stops resolving is not the same incident as
        // credentials being refused, and treating them as one would mean the
        // second never appears at all.
        FlakyS3 s3 = new FlakyS3();
        HlsPublisher publisher = new HlsPublisher(s3, "bucket", "live/cam/sub", dir, "cam/sub", 4);

        s3.failure = SdkClientException.create("Received an UnknownHostException");
        for (int i = 0; i < 5; i++) {
            writeSegment(dir, i);
            publisher.sync();
        }

        s3.failure = SdkClientException.create("The security token included in the request is invalid");
        for (int i = 5; i < 10; i++) {
            writeSegment(dir, i);
            publisher.sync();
        }

        String log = captured.toString(StandardCharsets.UTF_8);
        assertEquals(2, count(log, "upload failed"),
                "each distinct fault should be reported once, log was:\n" + log);
    }
}
