package online.camstream.agent.publish;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The init segment is uploaded once, however long anybody watches.
 *
 * The set of already-uploaded names is deliberately bounded: a stable camera
 * produces some forty thousand segment names a day, and remembering them all
 * was a leak. Forgetting is safe for segments because ffmpeg deletes them, so
 * a name that ages out has already left the directory and is never listed
 * again.
 *
 * The fMP4 init segment is the exception. ffmpeg writes it once and leaves it
 * there for the life of the run, so once its name aged out of the bound it
 * looked new and was uploaded again - and again, every window's worth of
 * segments, for as long as the stream lasted.
 *
 * Found in S3 rather than in the code: the init object's last-modified time
 * kept marching forward on a file served as immutable, roughly every thirty-two
 * segments, in two separate runs on two different machines. Nothing about the
 * stream misbehaved, which is exactly why it lasted - the cost is a few
 * thousand pointless requests a day across an estate, and nothing else.
 */
class InitSegmentUploadTest {

    /** How many segments ffmpeg leaves on disk before deleting the oldest. */
    private static final int WINDOW_ON_DISK = 8;

    /** Records what was PUT, so the test can count rather than mock deeply. */
    private static final class RecordingS3 implements S3Client {
        final List<String> keys = new ArrayList<>();

        @Override
        public PutObjectResponse putObject(PutObjectRequest request, RequestBody body) {
            keys.add(request.key());
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

    private static void write(Path dir, String name, String content) throws IOException {
        Files.writeString(dir.resolve(name), content, StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("the init segment is not re-uploaded when its name ages out")
    void initUploadedOnce(@TempDir Path dir) throws Exception {
        RecordingS3 s3 = new RecordingS3();
        // windowSize 4 gives the smallest bound the constructor allows (32),
        // so the eviction this guards against happens quickly rather than
        // after several hundred segments.
        HlsPublisher publisher = new HlsPublisher(s3, "bucket", "live/cam/sub", dir, "cam/sub", 4);

        write(dir, "abc_init.mp4", "init");
        publisher.sync();

        // Comfortably more segments than the bound, which is what it takes for
        // the init segment's name to be evicted and the file to look new again.
        for (int i = 0; i < 80; i++) {
            write(dir, String.format("abc_%06d.m4s", i), "segment " + i);
            publisher.sync();
            // ffmpeg keeps only a window of segments on disk and deletes the
            // rest. Modelling that matters: it is the reason forgetting old
            // names is safe, and without it this test would be asserting
            // against a directory that never behaves like a real one.
            if (i >= WINDOW_ON_DISK) {
                Files.deleteIfExists(dir.resolve(String.format("abc_%06d.m4s", i - WINDOW_ON_DISK)));
            }
        }

        long initPuts = s3.keys.stream().filter(k -> k.endsWith("_init.mp4")).count();
        assertEquals(1, initPuts,
                "the init segment should be uploaded exactly once, was " + initPuts);

        // The bound itself must survive: forgetting old segment names is the
        // whole point, and a fix that simply remembered everything would pass
        // the assertion above while restoring the leak it replaced.
        long segmentPuts = s3.keys.stream().filter(k -> k.endsWith(".m4s")).count();
        assertEquals(80, segmentPuts, "every segment should be uploaded exactly once");
    }
}
