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

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import online.camstream.agent.health.ResourceMonitor;
import online.camstream.agent.update.Updater;
import online.camstream.agent.health.Resources;
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

    /*
     * Write the log in UTF-8 whatever the host thinks its encoding is.
     *
     * Java 21 defaults file.encoding to UTF-8 but leaves the console streams on
     * the platform's native encoding, and slf4j-simple logs to System.err. On
     * Windows that made the log cp1252: an em-dash was written as the single
     * byte 0x97, so the file was not valid UTF-8 and anything reading it as
     * UTF-8 - grep, a log shipper, an engineer with an editor - saw a
     * replacement character, on exactly the lines explaining a fault.
     *
     * This has to run before the logger below is created, so it is a static
     * block placed above it rather than the first line of main(): static
     * initialisers run in textual order at class initialisation, which is
     * already too late by the time main() is entered.
     *
     * The launcher passes -Dstderr.encoding=UTF-8 as well, which fixes the same
     * thing one layer out. This one is here because it travels in the jar: the
     * update mechanism ships the jar and nothing else, so a fix that lives only
     * on the command line cannot reach a site that is already installed.
     */
    static {
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8));
        System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true, StandardCharsets.UTF_8));
    }

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

            // Watches what the machine has left. The publisher feeds it upload
            // timings, which is how the uplink gets measured under real load
            // rather than by a speed test on an idle link.
            ResourceMonitor resourceMonitor = new ResourceMonitor(Path.of(config.stateDir));
            manager.meter(resourceMonitor);

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

                        /**
                         * Sampled here, at the moment the heartbeat is sent, so
                         * the reading describes the interval it is reporting on.
                         *
                         * The verdict is applied as well as reported: the cap it
                         * returns becomes the agent's own limit, so a machine
                         * that is out of headroom stops taking on conversions
                         * rather than accepting them and stuttering.
                         */
                        @Override
                        public Resources.Verdict resources() {
                            lastSigns = resourceMonitor.sample();
                            Resources.Verdict verdict = Resources.assess(
                                    lastSigns,
                                    config.maxConcurrentTranscodes,
                                    manager.runningTranscodes(),
                                    config.segmentDurationMs);
                            config.resourceCap = verdict.maxConcurrentTranscodes();
                            return verdict;
                        }

                        @Override
                        public Resources.Snapshot vitalSigns() {
                            return lastSigns;
                        }

                        private Resources.Snapshot lastSigns = Resources.Snapshot.unknown();
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
                public void onCommand(String action, com.fasterxml.jackson.databind.JsonNode command) {
                    switch (action) {
                        case "scan" -> {
                            log.info("scan requested by the control plane");
                            discovery.scan();
                            registry.refresh();
                            device.report(true);
                        }
                        case "update" -> {
                            // Runs on the command worker, which is not the MQTT
                            // event loop: a download of tens of megabytes must
                            // not hold the connection open and silent long
                            // enough to miss a keepalive.
                            new Updater(Path.of(config.agentJarPath()), Path.of(config.stateDir))
                                    .apply(DeviceClient.version(),
                                            command.path("version").asText(null),
                                            command.path("build").asText(null),
                                            command.path("url").asText(null));
                        }
                        default -> log.warn("ignoring unknown command \"{}\"", action);
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

                // Credentials that arrive after a sweep are useless until the
                // next one, because a camera is resolved from the newest scan
                // and that scan authenticated with what the agent held at the
                // time. Repeating it here is what turns a two-minute recovery
                // into a complete one.
                device.whenCredentialsChange(() -> {
                    discovery.scan();
                    registry.refresh();
                    device.report(true);
                });

                /*
                 * Keep asking for configuration until we have it.
                 *
                 * Both existing paths are events - the fetch on connect, and a
                 * push when the control plane changes something. If the first
                 * fails and no push follows, nothing tries again, and the agent
                 * runs with no credentials and no cameras while looking
                 * healthy: connected, heartbeating, discovering devices it
                 * cannot authenticate against.
                 *
                 * A Pi that booted thirty-nine days behind spent a day in
                 * exactly that state. Every signed request was refused, and the
                 * console reported the camera as registered but never seen.
                 *
                 * Silent once configured: needsConfiguration() answers false
                 * and this costs one comparison a minute.
                 */
                supervisor.supervise(new Supervisor.Task(
                        "configuration",
                        Duration.ofMinutes(1),
                        false,
                        () -> {
                            if (device.needsConfiguration()) {
                                device.fetchConfig(-1);
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
                    // Before the manager, not after. The supervisor's threads
                    // are daemons and keep running until the JVM exits, so the
                    // 250ms publish task could be mid-tick during close() — or
                    // worse, fire a retry and start a rendition after
                    // stopAll() had already run, leaving exactly one orphaned
                    // ffmpeg at the moment this hook exists to prevent that.
                    supervisor.close();
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
