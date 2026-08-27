import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player } from './Player';
import {
  SessionSuperseded, declinedTranscodes, listCameras, manifestFor, playsNatively,
  startSession, watch,
  type Camera, type DeclinedTranscode, type SessionInfo } from './api';
import { NewPasswordRequired, completeNewPassword, currentSession, signIn, signOut } from './auth';
import { Admin } from './Admin';
import { canAdminister } from './admin';
import { CameraGrid, TranscodeQueued, Unplayable } from './CameraGrid';
import { ScopePicker, inScope, placesOf, useResolvedScope, type Scope } from './ScopePicker';
import type { CognitoUser } from 'amazon-cognito-identity-js';

type Screen = 'loading' | 'login' | 'newPassword' | 'live';

export default function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Cameras the viewer has asked the agent to transcode. Held here rather than
   * inferred, because the cost lands on the customer's own hardware.
   */
  const [transcoding, setTranscoding] = useState<string[]>([]);
  // Transcodes the site has no free slot for. Held separately from failures:
  // nothing is broken, the answer is "not right now".
  const [queued, setQueued] = useState<DeclinedTranscode[]>([]);
  /**
   * Cameras this browser accepted the codec for and then failed to decode.
   * Firefox on Windows does exactly that with HEVC, so what actually happened
   * during playback overrides what the probe claimed.
   */
  const [undecodable, setUndecodable] = useState<string[]>([]);
  /** Cameras whose manifest never appeared — the agent is not publishing. */
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [pendingUser, setPendingUser] = useState<CognitoUser | null>(null);
  const [admin, setAdmin] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  /**
   * The cameras currently rendered, which is what the agents are told to
   * publish. A screenful, never the estate: each one costs an encoder at the
   * edge and S3 requests per segment.
   */
  const [visible, setVisible] = useState<string[]>([]);

  // Read by the keepalive timer, which must not restart every time the
  // selection or the page changes.
  const selectedRef = useRef<Camera | null>(null);
  selectedRef.current = selected;
  const transcodingRef = useRef<string[]>([]);
  transcodingRef.current = transcoding;
  const visibleRef = useRef<string[]>([]);
  visibleRef.current = visible;

  const endSession = useCallback(async (message: string | null) => {
    await signOut();
    setSession(null);
    setCameras([]);
    setSelected(null);
    setScope(null);
    setAdmin(false);
    setShowAdmin(false);
    setTranscoding([]);
    setUndecodable([]);
    setUnavailable([]);
    setVisible([]);
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
          visibleRef.current,
          pinned ? { thingName: pinned.thingName, cameraId: pinned.cameraId } : undefined,
          transcodingRef.current,
        );
        if (!cancelled) {
          setQueued(declinedTranscodes(result));
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

  // Re-announce the moment the page, the pinned camera or the transcode set
  // changes, so paging does not wait out the keepalive before anything appears.
  useEffect(() => {
    if (!session) return;
    void watch(
      session.sessionId,
      visible,
      selected ? { thingName: selected.thingName, cameraId: selected.cameraId } : undefined,
      transcoding,
    ).then((result) => setQueued(declinedTranscodes(result))).catch(() => undefined);
  }, [selected, session, transcoding, visible]);

  const places = useMemo(() => placesOf(cameras), [cameras]);
  useResolvedScope(places, scope, setScope);

  const onVisible = useCallback((keys: string[]) => {
    // Compared before setting: the grid recomputes this on every render, and a
    // new array with the same contents would re-announce demand needlessly.
    setVisible((current) =>
      current.length === keys.length && current.every((k, i) => k === keys[i]) ? current : keys);
  }, []);

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

  const shown = cameras.filter((camera) => inScope(scope, camera));

  const markUndecodable = (camera: Camera) =>
    setUndecodable((ids) => ids.includes(camera.cameraId) ? ids : [...ids, camera.cameraId]);
  const markUnavailable = (camera: Camera) =>
    setUnavailable((ids) => ids.includes(camera.cameraId) ? ids : [...ids, camera.cameraId]);
  const requestTranscode = (camera: Camera) => {
    setUndecodable((ids) => ids.filter((id) => id !== camera.cameraId));
    setTranscoding((ids) => ids.includes(camera.cameraId) ? ids : [...ids, camera.cameraId]);
  };

  const queuedFor = (camera: Camera) => queued.find((q) => q.cameraId === camera.cameraId);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand"><span className="brand-mark">C</span>CamStream</span>
        <span className="topbar-spacer" />
        <div className="topbar-right">
          {session && <span className="tenant">{session.tenantId}</span>}
          {admin && (
            <button className="btn ghost" onClick={() => setShowAdmin(true)}>Administration</button>
          )}
          <button className="btn ghost" onClick={() => void endSession(null)}>Sign out</button>
        </div>
      </header>

      <main className="main">
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            {/* Dismissible: it reports something that already happened, and a
                band across the top of every page until reload is a nag. */}
            <button className="btn ghost small" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
          </div>
        )}

        {selected ? (
          <section className="detail">
            <div className="detail-bar">
              <button className="btn ghost" onClick={() => setSelected(null)}>← All cameras</button>
              <span className="detail-title">{selected.displayName}</span>
              <span className="badge">
                {transcoding.includes(selected.cameraId) ? 'main · transcoded' : 'main stream'}
              </span>
              {selected.siteName && <span className="detail-meta">{selected.siteName}</span>}
              {selected.ipAddress && <span className="detail-meta"><code>{selected.ipAddress}</code></span>}
            </div>
            <div className="detail-stage">
              <div className="player">
                {queuedFor(selected) ? (
                  <TranscodeQueued limit={queuedFor(selected)!.limit} />
                ) : (playsNatively(selected) && !undecodable.includes(selected.cameraId))
                  || transcoding.includes(selected.cameraId) ? (
                  <Player
                    src={manifestFor(selected, 'main', transcoding.includes(selected.cameraId))}
                    preferHighest
                    showStats
                    onUndecodable={() => markUndecodable(selected)}
                    onUnavailable={() => markUnavailable(selected)}
                  />
                ) : (
                  <Unplayable camera={selected} onTranscode={() => requestTranscode(selected)} />
                )}
              </div>
            </div>
          </section>
        ) : (
          <CameraGrid
            cameras={shown}
            picker={<ScopePicker cameras={cameras} scope={scope} onScope={setScope} />}
            transcoding={transcoding}
            undecodable={undecodable}
            unavailable={unavailable}
            queued={queued}
            onSelect={setSelected}
            onTranscode={requestTranscode}
            onUndecodable={markUndecodable}
            onUnavailable={markUnavailable}
            onVisible={onVisible}
          />
        )}
      </main>
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
      <h1><span className="brand-mark">C</span>CamStream</h1>
      {notice && <p className="notice">{notice}</p>}
      {!needsNewPassword && (
        <label className="field">
          Email
          <input type="email" value={email} autoComplete="username" required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
      )}
      <label className="field">
        {needsNewPassword ? 'New password' : 'Password'}
        <input type="password" value={password} required
               autoComplete={needsNewPassword ? 'new-password' : 'current-password'}
               onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <p className="login-error">{error}</p>}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? 'Working…' : needsNewPassword ? 'Set password' : 'Sign in'}
      </button>
    </form>
  );
}
