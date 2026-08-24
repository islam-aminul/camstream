package online.camstream.agent.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class CameraConfigTest {

    private static CameraConfig valid() {
        CameraConfig camera = new CameraConfig();
        camera.id = "front-door";
        camera.subStreamUrl = "rtsp://host/sub";
        return camera;
    }

    @Test
    void acceptsAWellFormedCamera() {
        CameraConfig camera = valid();
        assertDoesNotThrow(camera::validate);
        assertEquals("front-door", camera.name, "name should default to the id");
        assertEquals("tcp", camera.rtspTransport);
    }

    @Test
    void rejectsIdsThatWouldBreakTheTenantWildcard() {
        // '--' separates tenant from device in a thing name; allowing it inside
        // an id would let one tenant's CloudFront wildcard match another's path.
        CameraConfig camera = valid();
        camera.id = "front--door";
        assertThrows(IllegalArgumentException.class, camera::validate);
    }

    @Test
    void rejectsIdsThatAreNotUrlSafe() {
        for (String bad : new String[] {"Front-Door", "front door", "front_door", "-front", "front-", "ab"}) {
            CameraConfig camera = valid();
            camera.id = bad;
            assertThrows(IllegalArgumentException.class, camera::validate, "should reject id: " + bad);
        }
    }

    @Test
    void requiresASubStreamForTheGrid() {
        CameraConfig camera = valid();
        camera.subStreamUrl = null;
        camera.mainStreamUrl = "rtsp://host/main";
        assertThrows(IllegalArgumentException.class, camera::validate);
    }

    @Test
    void rejectsNonRtspUrls() {
        CameraConfig camera = valid();
        camera.subStreamUrl = "http://host/stream";
        assertThrows(IllegalArgumentException.class, camera::validate);
    }

    @Test
    void rejectsAnUnknownEncoderProfile() {
        CameraConfig camera = valid();
        camera.encoder = "libx264";
        // Not a typo: libx264 is deliberately absent, since it would force a
        // GPL ffmpeg build. Operators must go through the "custom" profile.
        assertThrows(IllegalArgumentException.class, camera::validate);
    }

    @Test
    void rejectsAnInvalidTransport() {
        CameraConfig camera = valid();
        camera.rtspTransport = "http";
        assertThrows(IllegalArgumentException.class, camera::validate);
    }
}
