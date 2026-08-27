import { useCallback, useEffect, useRef, useState } from 'react';
import { Player } from './Player';
import {
  SessionSuperseded, listCameras, manifestFor, playsNatively, startSession,
  transcodeWouldHelp, watch, type Camera, type SessionInfo,
} from './api';
import { NewPasswordRequired, completeNewPassword, currentSession, signIn, signOut } from './auth';
import { Admin } from './Admin';
import { canAdminister } from './admin';
import type { CognitoUser } from 'amazon-cognito-identity-js';

type Screen = 'loading' | 'login' | 'newPassword' | 'live';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Cameras the viewer has asked the agent to transcode. Held here rather than
   * inferred, because the cost lands on the customer's own hardware.
   */
  const [transcoding, setTranscoding] = useState<string[]>([]);
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null);
  const [admin, setAdmin] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);

  // Read by the keepalive timer, which must not restart every time the
  // selection changes.
  const selectedRef = useRef<Camera | null>(null);
  selectedRef.current = selected;
  const transcodingRef = useRef<string[]>([]);
  transcodingRef.current = transcoding;

  const endSession = useCallback(async (message: string | null) => {
    await signOut();
    setSession(null);
    setCameras([]);
    setSelected(null);
    setAdmin(false);
    setShowAdmin(false);
    setTranscoding([]);
    setNotice(message);
    setScreen('login');
  }, []);

  const beginSession = useCallback(async () => {
    const info = await startSession();
    setSession(info);
    setAdmin(await canAdminister());
    setScreen('live');
    setNotice(info.displacedPreviousSession ? 'Your previous session was signed out.' : null);
  }, []);

  // Resume an existing Cognito session on reload.
  useEffect(() => {
    currentSession()
      .then((existing) => (existing ? beginSession() : setScreen('login')))
      .catch(() => setScreen('login'));
  }, [beginSession]);

  // Keep the CloudFront cookies alive. Losing the race here means another
  // sign-in took the slot, which is a sign-out, not an error.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      startSession(session.sessionId)
        .then(setSession)
        .catch((err) => {
          if (err instanceof SessionSuperseded) {
            void endSession('You were signed out because this account signed in elsewhere.');
          }
        });
    }, session.refreshInSeconds * 1000);
    return () => clearInterval(timer);
  }, [session, endSession]);

  // Tell the agents what to publish, now and every keepalive interval. Without
  // this heartbeat the edge stops encoding and the streams go quiet.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;

    const announce = async () => {
      const pinned = selectedRef.current;
      try {
        const result = await watch(
          session.sessionId,
          true,
          pinned ? { thingName: pinned.thingName, cameraId: pinned.cameraId } : undefined,
          transcodingRef.current,
        );
        if (!cancelled) {
          const { cameras: list } = await listCameras();
          if (!cancelled) setCameras(list);
        }
        return result.keepaliveInSeconds;
      } catch (err) {
        if (err instanceof SessionSuperseded && !cancelled) {
          void endSession('You were signed out because this account signed in elsewhere.');
        }
        return 30;
      }
    };

    void announce();
    const timer = setInterval(() => void announce(), 25_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session, endSession]);

  // Re-announce immediately when the pinned camera changes, so switching to the
  // main stream does not wait for the next tick.
  useEffect(() => {
    if (!session) return;
    void watch(
      session.sessionId,
      true,
      selected ? { thingName: selected.thingName, cameraId: selected.cameraId } : undefined,
      transcoding,
    ).catch(() => undefined);
  }, [selected, session, transcoding]);

  if (screen === 'loading') return <div className="centre">Loading…</div>;

  // Admin work continues to hold the session and keepalive above, so agents
  // keep publishing while an administrator is configuring them.
  if (screen === 'live' && showAdmin) {
    return <Admin onExit={() => setShowAdmin(false)} />;
  }

  if (screen === 'login' || screen === 'newPassword') {
    return (
      <LoginScreen
        notice={notice}
        needsNewPassword={screen === 'newPassword'}
        onSignIn={async (email, password) => {
          try {
            await signIn(email, password);
            await beginSession();
          } catch (err) {
            if (err instanceof NewPasswordRequired) {
              setPendingUser(err.user);
              setScreen('newPassword');
              setNotice('Choose a new password to finish setting up this account.');
              return;
            }
            throw err;
          }
        }}
        onSetPassword={async (password) => {
          if (!pendingUser) return;
          await completeNewPassword(pendingUser, password);
          setPendingUser(null);
          await beginSession();
        }}
      />
    );
  }

  return (
    <div className="app">
      <header>
        <h1>CamStream</h1>
        <div className="header-right">
          {session && <span className="tenant">{session.tenantId}</span>}
          {admin && <button onClick={() => setShowAdmin(true)}>Administration</button>}
          <button onClick={() => void endSession(null)}>Sign out</button>
        </div>
      </header>

      {notice && <div className="notice">{notice}</div>}

      {selected ? (
        <section className="detail">
          <div className="detail-bar">
            <button onClick={() => setSelected(null)}>← All cameras</button>
            <strong>{selected.displayName}</strong>
            <span className="badge">
              {transcoding.includes(selected.cameraId) ? 'main · transcoded' : 'main stream'}
            </span>
          </div>
          {playsNatively(selected) || transcoding.includes(selected.cameraId) ? (
            <Player src={manifestFor(selected, 'main', transcoding.includes(selected.cameraId))} />
          ) : (
            <Unplayable
              camera={selected}
              onTranscode={() => setTranscoding((ids) => [...ids, selected.cameraId])}
            />
          )}
        </section>
      ) : (
        <section className="grid">
          {cameras.length === 0 && <p className="empty">No cameras are reporting in yet.</p>}
          {cameras.map((camera) => (
            <button
              key={`${camera.thingName}/${camera.cameraId}`}
              className="tile"
              onClick={() => {
                if (camera.online && (playsNatively(camera) || transcoding.includes(camera.cameraId))) {
                  setSelected(camera);
                }
              }}
              disabled={!camera.online}
            >
              {!camera.online ? (
                <div className="player"><div className="player-overlay">Offline</div></div>
              ) : playsNatively(camera) || transcoding.includes(camera.cameraId) ? (
                <Player src={manifestFor(camera, 'sub', transcoding.includes(camera.cameraId))} />
              ) : (
                <Unplayable
                  camera={camera}
                  onTranscode={() => setTranscoding((ids) => [...ids, camera.cameraId])}
                />
              )}
              <span className="tile-label">
                {camera.displayName}
                {transcoding.includes(camera.cameraId) && <span className="badge">transcoded</span>}
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * Offered rather than applied.
 *
 * Transcoding runs on the customer's own hardware and costs CPU there, so a
 * browser's limitations are surfaced as a choice with its price stated, not
 * silently turned into work at the edge.
 */
function Unplayable({ camera, onTranscode }: { camera: Camera; onTranscode: () => void }) {
  const possible = transcodeWouldHelp(camera);
  return (
    <div className="player">
      <div className="player-overlay unplayable">
        <span>This browser cannot play {(camera.sourceCodec ?? '').toUpperCase()}</span>
        {possible ? (
          <>
            <button onClick={(e) => { e.stopPropagation(); onTranscode(); }}>
              Transcode on the agent
            </button>
            <small>Converts to H.264 on the recorder. Uses CPU at the site.</small>
          </>
        ) : (
          <small>No other rendition would help — try Safari or Chrome.</small>
        )}
      </div>
    </div>
  );
}

interface LoginProps {
  notice: string | null;
  needsNewPassword: boolean;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSetPassword: (password: string) => Promise<void>;
}

function LoginScreen({ notice, needsNewPassword, onSignIn, onSetPassword }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsNewPassword) await onSetPassword(password);
      else await onSignIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>CamStream</h1>
      {notice && <p className="notice">{notice}</p>}
      {!needsNewPassword && (
        <label>
          Email
          <input type="email" value={email} autoComplete="username" required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
      )}
      <label>
        {needsNewPassword ? 'New password' : 'Password'}
        <input type="password" value={password} required
               autoComplete={needsNewPassword ? 'new-password' : 'current-password'}
               onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Working…' : needsNewPassword ? 'Set password' : 'Sign in'}
      </button>
    </form>
  );
}
