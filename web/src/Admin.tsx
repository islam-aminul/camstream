import { useCallback, useEffect, useState } from 'react';
import {
  approveCamera, createUser, deleteUser, listAgents, listDiscovered, listUsers,
  removeCamera, storeCredential,
  type Agent, type AdminUser, type DiscoveredCamera, type Sighting,
} from './admin';
import { cryptoAvailable, sealCredential } from './crypto';

type Tab = 'cameras' | 'agents' | 'users';

export function Admin({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('cameras');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cameras, setCameras] = useState<DiscoveredCamera[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [a, c, u] = await Promise.all([listAgents(), listDiscovered(), listUsers()]);
      setAgents(a.agents);
      setCameras(c.cameras);
      setUsers(u.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>CamStream — administration</h1>
        <div className="header-right">
          <button onClick={() => void refresh()} disabled={busy}>{busy ? 'Working…' : 'Refresh'}</button>
          <button onClick={onExit}>← Live view</button>
        </div>
      </header>

      <nav className="tabs">
        {(['cameras', 'agents', 'users'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'tab active' : 'tab'} onClick={() => setTab(name)}>
            {name === 'cameras' ? 'Cameras' : name === 'agents' ? 'Agents' : 'Users'}
          </button>
        ))}
      </nav>

      {error && <div className="notice error-notice">{error}</div>}

      {tab === 'cameras' && <Cameras cameras={cameras} agents={agents} act={act} />}
      {tab === 'agents' && <Agents agents={agents} act={act} />}
      {tab === 'users' && <Users users={users} act={act} />}
    </div>
  );
}

function Cameras({ cameras, agents, act }: {
  cameras: DiscoveredCamera[];
  agents: Agent[];
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  if (cameras.length === 0) {
    return <p className="empty">No cameras discovered yet. Agents sweep their network every 30 minutes.</p>;
  }
  return (
    <div className="stack">
      {cameras.map((camera) => (
        <CameraRow key={camera.identity} camera={camera} agents={agents} act={act} />
      ))}
    </div>
  );
}

function CameraRow({ camera, agents, act }: {
  camera: DiscoveredCamera;
  agents: Agent[];
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [assignedTo, setAssignedTo] = useState(camera.approved?.assignedTo ?? camera.reachableBy[0]?.thingName ?? '');
  const [displayName, setDisplayName] = useState(camera.approved?.displayName ?? camera.model ?? camera.identity);

  const sighting: Sighting | undefined =
    camera.reachableBy.find((s) => s.thingName === assignedTo) ?? camera.reachableBy[0];
  const profiles = sighting?.profiles ?? [];
  // Smallest rendition drives the grid, largest the detail view.
  const byHeight = [...profiles].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
  const sub = byHeight[0];
  const main = byHeight[byHeight.length - 1];

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <strong>{camera.manufacturer ?? 'Unknown'} {camera.model ?? ''}</strong>
          <span className="muted"> · {sighting?.ipAddress}</span>
          {camera.approved && <span className="badge ok">approved</span>}
          {!camera.identityStable && (
            <span className="badge warn" title="Identified only by IP address, which changes when the DHCP lease renews">
              unstable identity
            </span>
          )}
        </div>
        <code className="muted">{camera.identity}</code>
      </div>

      {camera.reachableBy.length > 1 && (
        <p className="muted small">
          Seen by {camera.reachableBy.length} agents. Only the one you assign will publish it.
        </p>
      )}

      <div className="row">
        <label>
          Name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          Published by
          <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            {camera.reachableBy.map((s) => (
              <option key={s.thingName} value={s.thingName}>
                {s.thingName} ({s.authState.toLowerCase().replace('_', ' ')})
              </option>
            ))}
          </select>
        </label>
      </div>

      {profiles.length > 0 && (
        <p className="muted small">
          {profiles.map((p) => `${p.name ?? p.token}: ${p.codec ?? '?'} ${p.width ?? '?'}×${p.height ?? '?'}`).join('  ·  ')}
        </p>
      )}

      <div className="row">
        <button
          disabled={!assignedTo}
          onClick={() => void act(() => approveCamera({
            identity: camera.identity,
            assignedTo,
            displayName,
            subProfileToken: sub?.token,
            mainProfileToken: main?.token,
            sourceCodec: main?.codec,
          }))}
        >
          {camera.approved ? 'Update' : 'Approve'}
        </button>
        {camera.approved && (
          <button onClick={() => void act(() => removeCamera(camera.identity))}>Remove</button>
        )}
      </div>

      <CredentialForm
        scope={camera.identity}
        agent={agents.find((a) => a.thingName === assignedTo)}
        act={act}
      />
    </section>
  );
}

/**
 * Encrypts in the browser before anything is sent. The control plane stores
 * ciphertext it cannot open, so there is no "show credential" anywhere — the
 * only copies are here, momentarily, and on the agent.
 */
function CredentialForm({ scope, agent, act }: {
  scope: string;
  agent: Agent | undefined;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return <button className="link" onClick={() => setOpen(true)}>Set camera credentials…</button>;
  }
  if (!cryptoAvailable()) {
    return <p className="error">This browser cannot encrypt credentials (WebCrypto requires HTTPS).</p>;
  }
  if (!agent) {
    return <p className="error">Choose an agent first.</p>;
  }
  if (!agent.credentialPublicKey) {
    return <p className="error">{agent.thingName} has not published an encryption key yet — wait for its next heartbeat.</p>;
  }

  return (
    <div className="credential">
      <p className="muted small">
        Encrypted in this browser for {agent.thingName}. CamStream's servers never receive a readable copy,
        and it cannot be recovered later — only replaced.
      </p>
      <div className="row">
        <label>
          Username
          <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button
          disabled={!username}
          onClick={() => void act(async () => {
            const ciphertext = await sealCredential(agent.credentialPublicKey!, username, password);
            await storeCredential({ thingName: agent.thingName, scope, ciphertext });
            setUsername('');
            setPassword('');
            setOpen(false);
          })}
        >
          Encrypt and send
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function Agents({ agents }: { agents: Agent[]; act: (work: () => Promise<unknown>) => Promise<void> }) {
  if (agents.length === 0) return <p className="empty">No agents have checked in.</p>;
  return (
    <table className="grid-table">
      <thead>
        <tr><th>Agent</th><th>Site</th><th>Version</th><th>Cameras</th><th>Key</th><th>Status</th></tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.thingName}>
            <td><code>{agent.thingName}</code></td>
            <td>{agent.siteName ?? '—'}</td>
            <td>{agent.agentVersion ?? '—'}</td>
            <td>{agent.cameraCount}</td>
            <td>{agent.credentialPublicKey ? 'published' : <span className="muted">pending</span>}</td>
            <td>
              <span className={agent.online ? 'badge ok' : 'badge warn'}>
                {agent.online ? 'online' : 'offline'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Users({ users, act }: { users: AdminUser[]; act: (work: () => Promise<unknown>) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [admin, setAdmin] = useState(false);
  return (
    <div className="stack">
      <section className="card">
        <strong>Invite a viewer</strong>
        <p className="muted small">They receive a temporary password by email and choose their own on first sign-in.</p>
        <div className="row">
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            Administrator
          </label>
          <button
            disabled={!email}
            onClick={() => void act(async () => {
              await createUser({ email, admin });
              setEmail('');
              setAdmin(false);
            })}
          >
            Invite
          </button>
        </div>
      </section>

      <table className="grid-table">
        <thead><tr><th>Email</th><th>Status</th><th /></tr></thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.username}>
              <td>{user.email ?? user.username}</td>
              <td><span className="muted">{user.status?.toLowerCase().replace(/_/g, ' ')}</span></td>
              <td>
                <button onClick={() => void act(() => deleteUser(user.username))}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
