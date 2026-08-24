package online.camstream.agent;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.control.StreamManager;
import online.camstream.agent.control.WatchListener;
import online.camstream.agent.credentials.CredentialEnvelope;
import online.camstream.agent.credentials.CredentialStore;
import online.camstream.agent.credentials.DeviceKeypair;
import online.camstream.agent.discovery.DiscoveryService;
import online.camstream.agent.iot.IotCredentialsProvider;
import online.camstream.agent.publish.HeartbeatClient;
import online.camstream.agent.supervise.Supervisor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;

import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;

/**
 * CamStreamAgent entry point.
 *
 *   java -jar camstream-agent.jar /path/to/agent.yaml
 *
 * Every long-running activity is registered with the {@link Supervisor} rather
 * than scheduled directly, so a failure anywhere is retried instead of quietly
 * ending. This box is typically unattended in a cupboard on someone else's
 * network.
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);

    /** How often ffmpeg output is swept into S3. Well under one segment. */
    private static final Duration SYNC_INTERVAL = Duration.ofMillis(250);
    private static final Duration HEARTBEAT_INTERVAL = Duration.ofSeconds(30);

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: camstream-agent <config.yaml>");
            System.exit(2);
        }

        AgentConfig config = AgentConfig.load(Path.of(args[0]));
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
                credentialStore::all);

        try (S3Client s3 = S3Client.builder()
                .region(Region.of(config.region))
                .credentialsProvider(awsCredentials)
                .httpClientBuilder(UrlConnectionHttpClient.builder())
                .build();
             StreamManager manager = new StreamManager(config, s3);
             Supervisor supervisor = new Supervisor(3)) {

            HeartbeatClient heartbeat = new HeartbeatClient(
                    config, awsCredentials, keypair::publicKeyBase64, discovery::redactedResults,
                    envelope, credentialStore);

            // Announce before subscribing, so the control plane already knows
            // this device's cameras when the first viewer asks for them.
            supervisor.runOnce(new Supervisor.Task("heartbeat-initial", HEARTBEAT_INTERVAL, heartbeat::send));

            try (WatchListener listener = new WatchListener(config, manager::apply)) {
                supervisor.supervise(new Supervisor.Task("publish", SYNC_INTERVAL, manager::tick));
                supervisor.supervise(new Supervisor.Task("heartbeat", HEARTBEAT_INTERVAL, heartbeat::send));

                if (config.discoveryEnabled) {
                    // Sweep at startup: an installer plugging in a new box
                    // should not wait a whole interval to see the cameras.
                    supervisor.supervise(new Supervisor.Task(
                            "discovery",
                            Duration.ofMinutes(config.discoveryIntervalMinutes),
                            true,
                            discovery::scan));
                } else {
                    log.info("camera discovery is disabled");
                }

                CountDownLatch shutdown = new CountDownLatch(1);
                Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                    log.info("shutting down");
                    shutdown.countDown();
                }));

                log.info("waiting for viewers");
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
