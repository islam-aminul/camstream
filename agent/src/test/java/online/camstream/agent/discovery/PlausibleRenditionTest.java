package online.camstream.agent.discovery;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A stated frame size that cannot be real is refused.
 *
 * A Hikvision recorder on a live site reported its main stream as 44x32.
 * Nothing refused it, so it became a profile — and because main and sub are
 * chosen by taking the largest and the smallest, the nonsense won "smallest"
 * and took the sub role.
 *
 * The sub is the rendition the wall pulls. So every tile on that recorder was
 * served the recorder's full-resolution stream instead of its 640x360: measured
 * at 1.8 MB per segment against 52 KB from a camera whose sub was real, on the
 * same wall at the same moment. Six channels of it.
 *
 * Nothing looked broken. The video played, the console showed six cameras
 * publishing, the agent used 6% of one core, and the only symptom was the bill.
 * It was found by reading segment sizes, not by anything failing.
 */
class PlausibleRenditionTest {

    @Test
    @DisplayName("the size that caused this is refused")
    void refusesTheRealCase() {
        assertFalse(RtspPathGuesser.isPlausibleRendition(44, 32),
                "44x32 is the misparse that inverted main and sub on a live recorder");
    }

    @Test
    @DisplayName("real renditions are kept")
    void keepsRealOnes() {
        // The two this site actually serves, plus the smallest sub anybody
        // configures in practice.
        assertTrue(RtspPathGuesser.isPlausibleRendition(1920, 1080));
        assertTrue(RtspPathGuesser.isPlausibleRendition(640, 360));
        assertTrue(RtspPathGuesser.isPlausibleRendition(320, 180));
        assertTrue(RtspPathGuesser.isPlausibleRendition(176, 144), "QCIF is old but legitimate");
    }

    @Test
    @DisplayName("unknown dimensions are not treated as a fault")
    void unknownIsAllowed() {
        // Some firmware reports nothing useful and streams perfectly well.
        // Refusing on absent dimensions would drop working cameras to fix a
        // problem about wrong ones, which is a worse trade than the bug.
        assertTrue(RtspPathGuesser.isPlausibleRendition(null, null));
        assertTrue(RtspPathGuesser.isPlausibleRendition(640, null));
        assertTrue(RtspPathGuesser.isPlausibleRendition(null, 360));
    }

    @Test
    @DisplayName("one dimension being impossible is enough")
    void bothDimensionsMustBePlausible() {
        // A misparse does not always mangle both numbers, and a rendition that
        // is 1920 wide and 32 high is no more real than 44x32.
        assertFalse(RtspPathGuesser.isPlausibleRendition(1920, 32));
        assertFalse(RtspPathGuesser.isPlausibleRendition(44, 1080));
    }
}
