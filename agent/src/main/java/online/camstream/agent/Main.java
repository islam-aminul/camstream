package online.camstream.agent;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.control.CameraRegistry;
import online.camstream.agent.control.Rendition;
import online.camstream.agent.control.SourceVerifier;
import online.camstream.agent.control.StreamManager;
import online.camstream.agent.control.WatchListener;
import online.camstream.agent.credentials.CredentialEnvelope;
import online.camstream.agent.credentials.CredentialStore;
import online.camstream.agent.credentials.DeviceKeypair;
import online.camstream.agent.discovery.DiscoveryService;
import online.camstream.agent.iot.IotCredentialsProvider;
import online.camstream.agent.provisioning.FleetProvisioner;
import online.camstream.agent.provisioning.IdentityFile;
import online.camstream.agent.publish.DeviceClient;
import online.camstream.agent.publish.Heartbeat;
import online.camstream.agent.supervise.Supervisor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;

/**
 * CamStreamAgent entry point.
 *
 *   java -jar camstream-agent.jar /path/to/agent.yaml
 *
 * On first boot the agent enrols itself from the identity file the admin
 * console produced, then holds one MQTT connection and does nothing on a timer
 * except sweep for cameras. Liveness, configuration and viewer demand all
 * arrive as pushes, so an idle site issues no requests at all.
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);

    /** How often ffmpeg output is swept into S3. Well under one segment. */
    private static final Duration SYNC_INTERVAL = Duration.ofMillis(250);

    /**
     * How often the heartbeat is *considered*, not how often it is sent.
     *
     * The interval that matters is chosen inside {@link Heartbeat} from whether
     * anything is being watched, so this only has to be fine-grained enough not
     * to blunt it. It costs a wakeup and nothing else.
     */
    private static final Duration HEARTBEAT_TICK = Duration.ofSeconds(20);

    /**
     * How often configured cameras are re-checked against what they stream.
     *
     * Slow on purpose: a camera's encoder settings change when somebody
     * changes them, and each check costs an ffprobe against the camera. The
     * result is cached per URL, so a settled site does no work at all here.
     */
    private static final Duration VERIFY_INTERVAL = Duration.ofMinutes(30);

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: camstream-agent <config.yaml>");
            System.exit(2);
        }

        AgentConfig config = AgentConfig.loadRaw(Path.of(args[0]));

        // Enrol before anything else needs a certificate.
        if (config.identityFile != null && !config.identityFile.isBlank()) {
            Path identityPath = Path.of(config.identityFile);
            if (Files.isRegularFile(identityPath)) {
                IdentityFile identity = IdentityFile.load(identityPath);
                config.applyIdentity(identity);
                config.resolveStatePaths();
                if (identity.canEnrol()
                        && FleetProvisioner.ensureProvisioned(identity, Path.of(config.stateDir))) {
                    // Spent; the endpoints stay, the secrets go.
                    identity.stripSecrets(identityPath);
                }
            } else {
                log.debug("no identity file at {}; assuming the device is already enrolled", identityPath);
            }
        }
        config.resolveStatePaths();
        config.validate();

        log.info("CamStreamAgent starting as {} ({} camera(s) configured)",
                config.thingName(), config.cameras.size());

        DeviceKeypair keypair = DeviceKeypair.loadOrCreate(Path.of(config.credentialKeyPath));
        CredentialEnvelope envelope = new CredentialEnvelope(keypair);
        CredentialStore credentialStore = new CredentialStore();
        credentialStore.setSiteCredentials(siteCredentials(config));

        IotCredentialsProvider awsCredentials = new IotCredentialsProvider(config);
        DiscoveryService discovery = new DiscoveryService(
                config.ffprobePath,
                config.defaultRtspTransport,
                config.rtspPaths,
                config.discoveryMaxHosts,
                config.discoveryNetworks,
                credentialStore::candidates);
        CameraRegistry registry = new CameraRegistry(config, discovery);

        try (S3Client s3 = S3Client.builder()
                .region(Region.of(config.region))
                .credentialsProvider(awsCredentials)
                .httpClientBuilder(UrlConnectionHttpClient.builder())
                .build();
             StreamManager manager = new StreamManager(config, s3, registry);
             Supervisor supervisor = new Supervisor(3)) {

            // The listener does not exist until its handlers do, and its
            // handlers need to reach it; this closes that loop.
            java.util.concurrent.atomic.AtomicReference<WatchListener> watch =
                    new java.util.concurrent.atomic.AtomicReference<>();

            DeviceClient device = new DeviceClient(
                    config, awsCredentials, keypair::publicKeyBase64, discovery::redactedResults,
                    () -> List.copyOf(supervisor.health()), envelope, credentialStore, registry);

            Heartbeat heartbeat = new Heartbeat(
                    (suffix, payload) -> {
                        WatchListener listener = watch.get();
                        if (listener == null) {
                            // onConnected fires from inside the listener's own
                            // constructor, before the reference is published.
                            // Failing here leaves lastSent unset, so the next
                            // tick sends it twenty seconds later.
                            throw new IllegalStateException("MQTT listener not ready");
                        }
                        listener.publish(suffix, payload);
                    },
                    new Heartbeat.Vitals() {
                        @Override
                        public int publishing() {
                            return manager.publishing();
                        }

                        @Override
                        public int camerasConfigured() {
                            return registry.all().size();
                        }

                        @Override
                        public List<Supervisor.TaskHealth> taskHealth() {
                            return supervisor.health();
                        }
                    },
                    DeviceClient.version(),
                    Duration.ofMinutes(config.heartbeatActiveMinutes),
                    Duration.ofMinutes(config.heartbeatIdleMinutes));

            WatchListener.Handlers handlers = new WatchListener.Handlers() {
                @Override
                public void onDesiredState(Set<Rendition> desired) {
                    manager.apply(desired);
                }

                @Override
                public void onConfigVersion(long version) {
                    device.fetchConfig(version);
                }

                @Override
                public void onCommand(String action) {
                    if ("scan".equals(action)) {
                        log.info("scan requested by the control plane");
                        discovery.scan();
                        registry.refresh();
                        device.report(true);
                    } else {
                        log.warn("ignoring unknown command \"{}\"", action);
                    }
                }

                @Override
                public void onConnected() {
                    // Reconcile on every connection, including reconnects after
                    // a network outage, when a config push may have been missed.
                    device.report(true);
                    device.fetchConfig(-1);
                    // First thing after a reconnect: say what state the agent
                    // came back in, rather than waiting out the interval.
                    heartbeat.sendNow();
                }
            };

            try (WatchListener listener = new WatchListener(config, handlers)) {
                watch.set(listener);
                supervisor.supervise(new Supervisor.Task("publish", SYNC_INTERVAL, manager::tick));
                supervisor.supervise(new Supervisor.Task("heartbeat", HEARTBEAT_TICK, heartbeat::tick));

                // Runs immediately as well as on the interval: a camera
                // mis-declared in agent.yaml should be corrected before the
                // first viewer meets it, not half an hour later.
                SourceVerifier verifier = new SourceVerifier(discovery, registry);
                supervisor.supervise(new Supervisor.Task(
                        "verify-sources", VERIFY_INTERVAL, true,
                        () -> {
                            if (verifier.verify()) {
                                // What the control plane believed about these
                                // cameras was wrong, so it needs telling.
                                device.report(true);
                            }
                        }));

                if (config.discoveryEnabled) {
                    supervisor.supervise(new Supervisor.Task(
                            "discovery",
                            Duration.ofMinutes(config.discoveryIntervalMinutes),
                            true,
                            () -> {
                                discovery.scan();
                                registry.refresh();
                                // Sent only when the result set actually differs.
                                device.report(false);
                            }));
                } else {
                    log.info("camera discovery is disabled");
                }

                CountDownLatch shutdown = new CountDownLatch(1);
                Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                    log.info("shutting down");
                    // Stop the encoders here rather than leaving it to
                    // try-with-resources on the main thread: the JVM exits as
                    // soon as the hooks finish, and losing that race orphans
                    // every ffmpeg child. Orphans keep their RTSP sessions
                    // open, and a camera with a handful of session slots then
                    // refuses everyone — including the agent, once it restarts.
                    manager.close();
                    shutdown.countDown();
                }));

                log.info("connected and idle — waiting for viewers");
                shutdown.await();
            }
        }
    }

    private static List<CredentialEnvelope.Credential> siteCredentials(AgentConfig config) {
        List<CredentialEnvelope.Credential> credentials = new ArrayList<>();
        for (AgentConfig.SiteCredential credential : config.cameraCredentials) {
            if (credential.username != null && !credential.username.isBlank()) {
                credentials.add(new CredentialEnvelope.Credential(
                        credential.username, credential.password == null ? "" : credential.password));
            }
        }
        return credentials;
    }
}
