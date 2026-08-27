package online.camstream.agent.media;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Segment duration is only achievable if a keyframe lands on every boundary,
 * so keyframe control is the part of the argument list that cannot be left out.
 */
class EncoderArgumentsTest {

    private static List<String> custom(String... args) {
        return EncoderArguments.video(EncoderProfile.CUSTOM, List.of(args), null, null, 2.0);
    }

    @Test
    void suppliesKeyframeForcingCustomArgumentsDidNotAskFor() {
        // Without this libx264 emits a keyframe every 250 frames, which turned
        // a 2-second segment request into 17-second segments — long enough
        // that a viewer gave up before the first one was ever published.
        List<String> args = custom("-c:v", "libx264", "-preset", "veryfast");
        assertTrue(args.contains("-force_key_frames"), args.toString());
        assertTrue(args.contains("expr:gte(t,n_forced*2.0)"), args.toString());
    }

    @Test
    void leavesAnOperatorsOwnKeyframeDecisionAlone() {
        assertFalse(custom("-c:v", "libx264", "-g", "30").contains("-force_key_frames"));
        assertEquals(1, custom("-c:v", "libx264", "-force_key_frames", "expr:eq(n,0)")
                .stream().filter("-force_key_frames"::equals).count());
        // An opinion expressed through a private option string counts too.
        assertFalse(custom("-c:v", "libx265", "-x265-params", "keyint=30:min-keyint=30")
                .contains("-force_key_frames"));
    }

    @Test
    void keepsTheOperatorsArgumentsAndTheirOrder() {
        List<String> args = custom("-c:v", "libx264", "-pix_fmt", "yuv420p");
        assertEquals(List.of("-c:v", "libx264", "-pix_fmt", "yuv420p"), args.subList(0, 4));
    }

    @Test
    void refusesCustomWithNoArgumentsAtAll() {
        assertThrows(IllegalArgumentException.class,
                () -> EncoderArguments.video(EncoderProfile.CUSTOM, List.of(), null, null, 2.0));
    }

    @Test
    void copyNeverGainsEncoderArguments() {
        List<String> args = EncoderArguments.video(EncoderProfile.COPY, null, null, null, 2.0);
        assertEquals(List.of("-c:v", "copy"), args);
    }

    @Test
    void hardwareEncodersProduceEightBitOutput() {
        // The point of the transcode is a stream browsers decode; carrying a
        // 10-bit source through would reproduce the problem it exists to fix.
        List<String> nvenc = EncoderArguments.video(EncoderProfile.NVENC, null, 2000, null, 2.0);
        assertTrue(String.join(" ", nvenc).contains("yuv420p"), nvenc.toString());
        assertTrue(nvenc.contains("-force_key_frames"));
    }
}
