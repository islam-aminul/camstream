package online.camstream.agent.media;

import online.camstream.agent.config.AgentConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The first segment is short, so a tile has something to play sooner.
 *
 * A viewer waits for a whole segment before there is anything to show, so the
 * first one decides how long a tile reads "starting". At a four-second segment
 * length that is four seconds of video before anything exists, on top of the
 * RTSP connect and the wait for a keyframe.
 *
 * ffmpeg cuts at the first keyframe *after* the target, which is the detail
 * that matters: a target under the camera's keyframe interval yields exactly
 * one group of pictures, while a target equal to it waits for the *next*
 * keyframe and yields two.
 *
 * Measured against a real camera with a two-second GOP, three runs each:
 *
 *   hls_time 4 alone      6.1, 6.5, 6.6  -> 6.4s
 *   hls_init_time 2       4.7, 4.7, 5.7  -> 5.0s
 *   hls_init_time 1       2.5, 3.1, 3.4  -> 3.0s
 *
 * So one second is not a rounded-down guess; two seconds measurably loses most
 * of the benefit on exactly the cameras this was built for.
 */
class FirstSegmentTest {

    private static AgentConfig config() {
        AgentConfig config = new AgentConfig();
        config.tenantId = "acme";
        config.premisesId = "acme-hq";
        config.deviceId = "gate-01";
        config.bucket = "b";
        config.iotCredentialsEndpoint = "c";
        config.iotDataEndpoint = "d";
        config.certificatePath = "/tmp/k.crt";
        config.privateKeyPath = "/tmp/k.key";
        config.apiInvokeUrl = "https://example.invalid";
        return config;
    }

    @Test
    @DisplayName("the initial length is under the shortest keyframe interval anyone uses")
    void shorterThanAGop() {
        // Two seconds is the shortest keyframe interval seen on real hardware
        // here. Anything at or above it stops producing one-GOP segments, which
        // is the whole mechanism, so this is the bound that matters rather than
        // the exact value.
        AgentConfig config = config();
        assertTrue(config.initialSegmentDurationMs > 0,
                "zero would switch the mechanism off silently");
        assertTrue(config.initialSegmentDurationMs < 2000,
                "at or above a two-second GOP this yields two groups of pictures, not one");
    }

    @Test
    @DisplayName("and shorter than the settled segment length")
    void shorterThanTheSteadyState() {
        // If it ever exceeded segmentDurationMs the first segments would be
        // longer than the rest, which is the opposite of the intent and would
        // read as a mistake nobody could see from the outside.
        AgentConfig config = config();
        assertTrue(config.initialSegmentDurationMs < config.segmentDurationMs,
                "the first segments must be shorter than the ones that follow");
    }

    @Test
    @DisplayName("a validated config still accepts it")
    void survivesValidation() {
        // The value is new, and validate() rejects several fields outright;
        // this pins that it does not reject a default the agent ships with.
        AgentConfig config = config();
        config.resolveStatePaths();
        config.validate();
        assertTrue(config.initialSegmentDurationMs >= 0);
    }
}
