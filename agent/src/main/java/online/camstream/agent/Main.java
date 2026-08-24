package online.camstream.agent;

import online.camstream.agent.config.AgentConfig;
import online.camstream.agent.control.StreamManager;
import online.camstream.agent.control.WatchListener;
import online.camstream.agent.iot.IotCredentialsProvider;
import online.camstream.agent.publish.HeartbeatClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;

import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * CamStreamAgent entry point.
 *
 *   java -jar camstream-agent.jar /path/to/agent.yaml
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);

    /** How often ffmpeg output is swept into S3. Well under one segment. */
    private static final long SYNC_INTERVAL_MS = 250;
    private static final long HEARTBEAT_INTERVAL_S = 30;

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: camstream-agent <config.yaml>");
            System.exit(2);
        }

        AgentConfig config = AgentConfig.load(Path.of(args[0]));
        log.info("CamStreamAgent starting as {} ({} cameras)", config.thingName(), config.cameras.size());

        IotCredentialsProvider credentials = new IotCredentialsProvider(config);

        try (S3Client s3 = S3Client.builder()
                .region(Region.of(config.region))
                .credentialsProvider(credentials)
                .httpClientBuilder(UrlConnectionHttpClient.builder())
                .build();
             StreamManager manager = new StreamManager(config, s3)) {

            HeartbeatClient heartbeat = new HeartbeatClient(config, credentials);
            // Announce before subscribing, so the control plane already knows
            // this device's cameras when the first viewer asks for them.
            heartbeat.send();

            try (WatchListener listener = new WatchListener(config, manager::apply)) {
                ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2, runnable -> {
                    Thread thread = new Thread(runnable);
                    thread.setDaemon(true);
                    return thread;
                });
                scheduler.scheduleWithFixedDelay(
                        guarded(manager::tick), SYNC_INTERVAL_MS, SYNC_INTERVAL_MS, TimeUnit.MILLISECONDS);
                scheduler.scheduleWithFixedDelay(
                        guarded(heartbeat::send), HEARTBEAT_INTERVAL_S, HEARTBEAT_INTERVAL_S, TimeUnit.SECONDS);

                CountDownLatch shutdown = new CountDownLatch(1);
                Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                    log.info("shutting down");
                    scheduler.shutdownNow();
                    shutdown.countDown();
                }));

                log.info("waiting for viewers");
                shutdown.await();
            }
        }
    }

    /** A scheduled task that throws is silently cancelled — never let that happen. */
    private static Runnable guarded(Runnable task) {
        return () -> {
            try {
                task.run();
            } catch (RuntimeException e) {
                log.error("scheduled task failed", e);
            }
        };
    }
}
