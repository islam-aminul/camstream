package online.camstream.agent.credentials;

import online.camstream.agent.credentials.CredentialEnvelope.Credential;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Comparator;
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

    /**
     * Held apart by where they came from, because they are withdrawn
     * differently. Local ones change when the operator edits agent.yaml;
     * relayed ones are whatever the last configuration fetch contained, and
     * anything missing from it has been withdrawn upstream.
     *
     * They used to share one list, which is why a credential deleted in the
     * console went on being used until the process restarted: there was no way
     * to clear the relayed ones without also discarding the local ones.
     */
    private final List<Credential> local = new ArrayList<>();
    private final List<Credential> relayedSiteWide = new ArrayList<>();
    private final Map<String, Credential> relayedPerCamera = new LinkedHashMap<>();

    /** Credentials from the agent's own config file. Replaced, not merged. */
    public void setSiteCredentials(List<Credential> credentials) {
        lock.writeLock().lock();
        try {
            local.clear();
            local.addAll(credentials);
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
            // Replace rather than merge. The configuration document is the
            // whole of what the control plane currently holds for this agent,
            // so a scope absent from it has been withdrawn — and merging meant
            // a revoked credential was still tried until the agent restarted,
            // which made revocation something the console could not actually
            // do. An empty document therefore clears everything relayed, and
            // deliberately leaves the local ones alone.
            relayedSiteWide.clear();
            relayedPerCamera.clear();
            // Site-wide credentials are tried in the order the site set them,
            // so the scopes are sorted rather than taken as the map hands them
            // over. A site may hold several - the first that a camera accepts
            // wins, and the order is the installer's judgement about which is
            // most likely.
            List<String> scopes = new ArrayList<>(ciphertextByCamera.keySet());
            scopes.sort(Comparator.nullsFirst(Comparator.naturalOrder()));
            for (String scope : scopes) {
                try {
                    Credential credential = envelope.open(ciphertextByCamera.get(scope));
                    if (isSiteWide(scope)) {
                        if (!relayedSiteWide.contains(credential)) {
                            relayedSiteWide.add(credential);
                        }
                    } else {
                        relayedPerCamera.put(scope, credential);
                    }
                } catch (IllegalArgumentException e) {
                    log.warn("could not open the credential for \"{}\": {}", scope, e.getMessage());
                }
            }
        } finally {
            lock.writeLock().unlock();
        }
    }

    /**
     * Whether a scope names every camera at the site rather than one of them.
     *
     * "*" is the first such slot and "*-2" onwards are the rest, which is what
     * lets a site hold several and keeps them in a defined order: "*" sorts
     * before "*-2" because it is a prefix of it.
     */
    private static boolean isSiteWide(String scope) {
        return scope == null || scope.isBlank() || scope.charAt(0) == '*';
    }

    /** Everything worth trying, most specific first. */
    public List<Credential> candidates(String cameraId) {
        lock.readLock().lock();
        try {
            List<Credential> candidates = new ArrayList<>();
            Credential specific = cameraId == null ? null : relayedPerCamera.get(cameraId);
            if (specific != null) {
                candidates.add(specific);
            }
            // Relayed before local: the console is the more recent authority.
            for (Credential credential : relayedSiteWide) {
                if (!candidates.contains(credential)) {
                    candidates.add(credential);
                }
            }
            for (Credential credential : local) {
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
            return local.size() + relayedSiteWide.size() + relayedPerCamera.size();
        } finally {
            lock.readLock().unlock();
        }
    }
}
