package online.camstream.agent.credentials;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * Camera credentials this agent may use, held in memory only.
 *
 * Two sources feed it: the local config file, and envelopes the control plane
 * relayed but could not read. Nothing here is ever written to disk or sent
 * upward — losing power means the operator re-supplies them, which is the
 * deliberate cost of the cloud never holding a decryptable copy.
 */
public final class CredentialStore {

    private static final Logger log = LoggerFactory.getLogger(CredentialStore.class);

    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();
    private final List<Credential> siteWide = new ArrayList<>();
    private final Map<String, Credential> perCamera = new LinkedHashMap<>();

    /** Credentials from the agent's own config file. Replaced, not merged. */
    public void setSiteCredentials(List<Credential> credentials) {
        lock.writeLock().lock();
        try {
            siteWide.clear();
            siteWide.addAll(credentials);
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Applies envelopes delivered by the control plane.
     *
     * One that fails to open is dropped with a warning rather than throwing:
     * it usually means the device was re-provisioned and the admin encrypted
     * against a stale public key, which the next heartbeat corrects.
     */
    public void apply(CredentialEnvelope envelope, Map<String, String> ciphertextByCamera) {
        lock.writeLock().lock();
        try {
            for (Map.Entry<String, String> entry : ciphertextByCamera.entrySet()) {
                try {
                    Credential credential = envelope.open(entry.getValue());
                    String scope = entry.getKey();
                    if (scope == null || scope.isBlank() || scope.equals("*")) {
                        if (!siteWide.contains(credential)) {
                            siteWide.add(credential);
                        }
                    } else {
                        perCamera.put(scope, credential);
                    }
                } catch (IllegalArgumentException e) {
                    log.warn("could not open the credential for \"{}\": {}", entry.getKey(), e.getMessage());
                }
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    /** Everything worth trying, most specific first. */
    public List<Credential> candidates(String cameraId) {
        lock.readLock().lock();
        try {
            List<Credential> candidates = new ArrayList<>();
            Credential specific = cameraId == null ? null : perCamera.get(cameraId);
            if (specific != null) {
                candidates.add(specific);
            }
            for (Credential credential : siteWide) {
                if (!candidates.contains(credential)) {
                    candidates.add(credential);
                }
            }
            return candidates;
        } finally {
            lock.readLock().unlock();
        }
    }

    public List<Credential> all() {
        return candidates(null);
    }

    public int size() {
        lock.readLock().lock();
        try {
            return siteWide.size() + perCamera.size();
        } finally {
            lock.readLock().unlock();
        }
    }
}
