package online.camstream.agent.config;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Agent configuration, loaded from YAML.
 *
 * Anything secret (the device private key) is referenced by path rather than
 * inlined, so the config file itself is safe to keep in configuration
 * management.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class AgentConfig {

    /** Tenant this device belongs to; must match the tenant half of the thing name. */
    public String tenantId;

    /** Site this device belongs to. Thing name is {@code <tenant>--<premises>--<device>}. */
    public String premisesId;

    /** Device half of the thing name. */
    public String deviceId;

    /**
     * Identity file produced by the admin console. When present, the agent
     * enrols itself on first boot and takes its endpoints from here, so a
     * config file need only carry local preferences.
     */
    public String identityFile;

    /** Where the device certificate, keys and working state live. */
    public String stateDir;

    /** Friendly site label, reported on heartbeat. */
    public String siteName;

    public String region = "ap-south-1";

    /** Bucket receiving HLS output. */
    public String bucket;

    /** IoT credentials endpoint, e.g. c2xxxxxxxxxxxx.credentials.iot.ap-south-1.amazonaws.com */
    public String iotCredentialsEndpoint;

    /** IoT role alias exchanged for temporary AWS credentials. */
    public String roleAlias = "camstream-device";

    /**
     * The device certificate and key, in PEM.
     *
     * Written by fleet provisioning on first boot. Used directly by the CRT
     * MQTT client, and converted in memory for the JSSE call to the IoT
     * credentials endpoint — no PKCS#12 file is kept on disk.
     */
    public String certificatePath;
    public String privateKeyPath;

    /**
     * Direct API Gateway endpoint, e.g. https://abc123.execute-api.ap-south-1.amazonaws.com
     *
     * Deliberately not the CloudFront domain: SigV4 signs the Host header, and
     * CloudFront rewrites Host to the origin, which would invalidate every
     * signature. Agents therefore bypass the CDN for control-plane calls.
     */
    public String apiInvokeUrl;

    /** IoT Core data endpoint used to receive watch commands over MQTT. */
    public String iotDataEndpoint;

    /**
     * Target segment duration in milliseconds.
     *
     * This is the main cost/latency dial. Each segment costs two S3 PUTs (the
     * media file and the rewritten playlist), so halving the duration doubles
     * the request bill. 2s lands around 5s of glass-to-glass latency; 4s halves
     * request cost for roughly double the delay.
     */
    public int segmentDurationMs = 2000;

    /** Segments kept in the live playlist window. */
    public int playlistWindow = 4;

    /**
     * Stop publishing a rendition this long after the last viewer keepalive.
     * Nothing is published — and nothing is billed — while no one is watching.
     */
    public int idleShutdownSeconds = 30;

    public String ffmpegPath = "ffmpeg";
    public String ffprobePath = "ffprobe";

    /** Scan the local network for cameras. */
    public boolean discoveryEnabled = true;

    /** Minutes between full sweeps. Cameras rarely appear, so this is slow on purpose. */
    public int discoveryIntervalMinutes = 30;

    /**
     * Ceiling on addresses scanned per sweep. 0 means scan whatever the
     * interface netmask covers, which is the right answer on a normal site
     * network and the default.
     */
    public int discoveryMaxHosts = 0;

    /**
     * Extra networks to sweep, as CIDRs.
     *
     * Cameras are commonly on their own VLAN, separate from the box running the
     * agent — in which case the interface netmask alone finds nothing.
     */
    public java.util.List<String> discoveryNetworks = new java.util.ArrayList<>();

    /**
     * RTSP paths tried on cameras with no usable ONVIF media service. Empty
     * uses the built-in vendor list.
     */
    public java.util.List<String> rtspPaths = new java.util.ArrayList<>();

    /**
     * RSA key used to open credentials the admin UI encrypted for this device.
     * Generated on first run; defaults to sitting beside the keystore.
     */
    public String credentialKeyPath;

    /**
     * Credentials to try against discovered cameras.
     *
     * These live on the customer's own hardware, which is the point — the
     * control plane never receives them. Anything entered through the admin UI
     * arrives encrypted for this device instead.
     */
    public java.util.List<SiteCredential> cameraCredentials = new java.util.ArrayList<>();

    /** A username/password pair to try during discovery. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static final class SiteCredential {
        public String username;
        public String password;
    }

    public List<CameraConfig> cameras = new ArrayList<>();

    public static AgentConfig load(Path path) throws IOException {
        AgentConfig config = loadRaw(path);
        config.resolveStatePaths();
        config.validate();
        return config;
    }

    /**
     * Reads the file without validating.
     *
     * Enrollment fills in most of the required fields, so validation cannot run
     * until the identity file has been applied.
     */
    public static AgentConfig loadRaw(Path path) throws IOException {
        ObjectMapper mapper = new ObjectMapper(new YAMLFactory());
        return mapper.readValue(Files.readString(path), AgentConfig.class);
    }

    public String thingName() {
        return tenantId + "--" + premisesId + "--" + deviceId;
    }

    /**
     * Fills in everything the admin console already knows.
     *
     * Explicit values in the config file win: an operator who overrode an
     * endpoint for a proxied or air-gapped site meant it.
     */
    public void applyIdentity(online.camstream.agent.provisioning.IdentityFile identity) {
        tenantId = orElse(tenantId, identity.tenantId);
        premisesId = orElse(premisesId, identity.premisesId);
        deviceId = orElse(deviceId, identity.deviceId);
        region = orElse(region, identity.region);
        bucket = orElse(bucket, identity.bucket);
        apiInvokeUrl = orElse(apiInvokeUrl, identity.apiInvokeUrl);
        iotDataEndpoint = orElse(iotDataEndpoint, identity.iotDataEndpoint);
        iotCredentialsEndpoint = orElse(iotCredentialsEndpoint, identity.iotCredentialsEndpoint);
        roleAlias = orElse(roleAlias, identity.roleAlias);
    }

    /** Resolves paths that default to sitting under the state directory. */
    public void resolveStatePaths() {
        Path state = Path.of(stateDir == null || stateDir.isBlank() ? "." : stateDir);
        certificatePath = orElse(certificatePath, state.resolve("device.crt").toString());
        privateKeyPath = orElse(privateKeyPath, state.resolve("device.key").toString());
        credentialKeyPath = orElse(credentialKeyPath, state.resolve("credential-key.pem").toString());
    }

    private static String orElse(String current, String fallback) {
        return current == null || current.isBlank() ? fallback : current;
    }

    /** S3 key prefix this device is allowed to write beneath. */
    public String keyPrefix() {
        return "live/" + thingName() + "/";
    }

    public void validate() {
        requireId("tenantId", tenantId);
        requireId("premisesId", premisesId);
        requireId("deviceId", deviceId);
        require("bucket", bucket);
        require("iotCredentialsEndpoint", iotCredentialsEndpoint);
        require("certificatePath", certificatePath);
        require("privateKeyPath", privateKeyPath);
        require("apiInvokeUrl", apiInvokeUrl);
        require("iotDataEndpoint", iotDataEndpoint);

        if (segmentDurationMs < 500 || segmentDurationMs > 10_000) {
            throw new IllegalArgumentException("segmentDurationMs must be between 500 and 10000");
        }
        if (playlistWindow < 3 || playlistWindow > 12) {
            throw new IllegalArgumentException("playlistWindow must be between 3 and 12");
        }
        if (idleShutdownSeconds < 10 || idleShutdownSeconds > 600) {
            throw new IllegalArgumentException("idleShutdownSeconds must be between 10 and 600");
        }
        if (discoveryIntervalMinutes < 1 || discoveryIntervalMinutes > 1440) {
            throw new IllegalArgumentException("discoveryIntervalMinutes must be between 1 and 1440");
        }
        if (discoveryMaxHosts < 0) {
            throw new IllegalArgumentException("discoveryMaxHosts must be 0 (unlimited) or positive");
        }
        if (credentialKeyPath == null || credentialKeyPath.isBlank()) {
            Path certificate = Path.of(certificatePath);
            Path parent = certificate.getParent();
            credentialKeyPath = (parent == null ? Path.of("credential-key.pem")
                    : parent.resolve("credential-key.pem")).toString();
        }
        // No cameras is a normal starting state, not an error: discovery finds
        // them, or an administrator assigns them centrally. Refusing to start
        // here would break exactly the zero-touch install this is built for.
        for (CameraConfig camera : cameras) {
            camera.validate();
        }
        long distinct = cameras.stream().map(c -> c.id).distinct().count();
        if (distinct != cameras.size()) {
            throw new IllegalArgumentException("duplicate camera ids in configuration");
        }
    }

    private static void require(String field, String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("missing required config field: " + field);
        }
    }

    private static void requireId(String field, String value) {
        require(field, value);
        if (!value.matches("[a-z0-9]+(-[a-z0-9]+)*") || value.contains("--") || value.length() < 3 || value.length() > 32) {
            throw new IllegalArgumentException(field + " must be 3-32 chars of [a-z0-9-] and must not contain '--'");
        }
    }
}
