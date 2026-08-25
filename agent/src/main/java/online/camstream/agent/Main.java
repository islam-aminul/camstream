package online.camstream.agent;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.control.CameraRegistry;
import online.camstream.agent.control.Rendition;
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
                config.cameras.isEmpty() ? "tcp" : config.cameras.get(0).rtspTransport,
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

            DeviceClient device = new DeviceClient(
                    config, awsCredentials, keypair::publicKeyBase64, discovery::redactedResults,
                    () -> List.copyOf(supervisor.health()), envelope, credentialStore, registry);

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
                }
            };

            try (WatchListener ignored = new WatchListener(config, handlers)) {
                supervisor.supervise(new Supervisor.Task("publish", SYNC_INTERVAL, manager::tick));

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
