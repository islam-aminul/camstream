import { useCallback, useEffect, useState } from 'react';
import {
  approveCamera, createAgent, createPremises, createUser, deletePremises, deleteUser,
  downloadInstaller, listAgents, listDiscovered, listPremises, listUsers,
  removeCamera, requestScan, storeCredential, whoAmI,
  type Agent, type AdminUser, type DiscoveredCamera, type Me, type Platform,
  type Premises, type Role, type Sighting, setTranscodeLimit } from './admin';
import { cryptoAvailable, sealCredential } from './crypto';

type Tab = 'cameras' | 'agents' | 'premises' | 'users';

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'linux', label: 'Linux (systemd)' },
  { id: 'windows', label: 'Windows' },
  { id: 'macos', label: 'macOS' },
];

/**
 * Guesses the platform of the machine the installer is likely destined for.
 * Only a default — the agent is rarely installed on the browsing machine.
 */
function guessPlatform(): Platform {
  const agent = navigator.userAgent;
  if (/Windows/i.test(agent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macos';
  return 'linux';
}

export function Admin({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('cameras');
  const [me, setMe] = useState<Me | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [premises, setPremises] = useState<Premises[]>([]);
  const [cameras, setCameras] = useState<DiscoveredCamera[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const who = await whoAmI();
      setMe(who);
      const [a, p, c] = await Promise.all([listAgents(), listPremises(), listDiscovered()]);
      setAgents(a.agents);
      setPremises(p.premises);
      setCameras(c.cameras);
      // Only admins may list users; an operator asking would just get a 403.
      if (who.role === 'admin' || who.role === 'superadmin') {
        setUsers((await listUsers()).users);
      }
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
    <div className="admin">
      <header className="topbar">
        <span className="brand"><span className="brand-mark">C</span>CamStream</span>
        <span className="tenant">administration</span>
        <span className="topbar-spacer" />
        <div className="topbar-right">
          {me && <span className="tenant">{me.tenantId} · {me.role}</span>}
          <button className="btn ghost" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Working…' : 'Refresh'}
          </button>
          <button className="btn" onClick={onExit}>← Live view</button>
        </div>
      </header>

      <nav className="tabs">
        {(['cameras', 'agents', 'premises', 'users'] as Tab[])
          .filter((name) => name !== 'users' || me?.role === 'admin' || me?.role === 'superadmin')
          .map((name) => (
            <button key={name} className={tab === name ? 'on' : ''} onClick={() => setTab(name)}>
              {name}
            </button>
          ))}
      </nav>

      {error && <div className="notice error">{error}</div>}

      {tab === 'cameras' && <Cameras cameras={cameras} agents={agents} act={act} />}
      {tab === 'agents' && <Agents agents={agents} premises={premises} act={act} />}
      {tab === 'premises' && <PremisesTab premises={premises} agents={agents} act={act} />}
      {tab === 'users' && <Users users={users} premises={premises} me={me} act={act} />}
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
          {camera.approved && <span className="badge ok">approved</span>}
          {!camera.identityStable && (
            <span className="badge warn" title="Identified only by IP address, which changes when the DHCP lease renews">
              unstable identity
            </span>
          )}
        </div>
        <code className="muted">{camera.identity}</code>
      </div>

      {/* Both addresses, always, and labelled. The identity is derived from the
          MAC, so showing them together makes that derivation visible instead of
          leaving the operator to decode an opaque string — and the IP is what
          they need to open the camera's own web interface. */}
      <div className="addresses">
        <span><span className="addr-label">MAC</span>
          <code>{camera.macAddress ?? <span className="muted">not readable</span>}</code>
        </span>
        <span><span className="addr-label">IP</span>
          <code>{sighting?.ipAddress ?? <span className="muted">unknown</span>}</code>
        </span>
        {camera.identifiedBy && (
          <span className="muted small">
            identified by {camera.identifiedBy === 'mac' ? 'hardware address'
              : camera.identifiedBy === 'serial' ? 'serial number' : 'network address'}
          </span>
        )}
      </div>

      {camera.reachableBy.length > 1 && (
        <p className="muted small">
          Seen by {camera.reachableBy.length} agents. Only the one you assign will publish it.
        </p>
      )}

      <div className="row">
        <label className="field">
          Name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
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
        <button className="btn"
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
          <button className="btn" onClick={() => void act(() => removeCamera(camera.identity))}>Remove</button>
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
        <label className="field">
          Username
          <input value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          Password
          <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="btn"
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
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function Agents({ agents, premises, act }: {
  agents: Agent[];
  premises: Premises[];
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [premisesId, setPremisesId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [siteName, setSiteName] = useState('');
  const [platform, setPlatform] = useState<Platform>(guessPlatform());
  const [downloaded, setDownloaded] = useState<string | null>(null);

  return (
    <div className="stack">
      <section className="card">
        <strong>Enrol an agent</strong>
        <p className="muted small">
          Creates the device and issues a single-use token. Download its installer, run it on the
          box, and the agent enrols itself — no certificates to copy.
        </p>
        <div className="row">
          <label className="field">
            Premises
            <select value={premisesId} onChange={(e) => setPremisesId(e.target.value)}>
              <option value="">Choose…</option>
              {premises.map((p) => (
                <option key={p.premisesId} value={p.premisesId}>{p.displayName}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Device id
            <input value={deviceId} placeholder="gate-01"
                   onChange={(e) => setDeviceId(e.target.value.toLowerCase())} />
          </label>
          <label className="field">
            Label
            <input value={siteName} placeholder="Main Gate" onChange={(e) => setSiteName(e.target.value)} />
          </label>
          <button className="btn"
            disabled={!premisesId || !deviceId}
            onClick={() => void act(async () => {
              await createAgent({ premisesId, deviceId, siteName: siteName || deviceId });
              setDeviceId('');
              setSiteName('');
            })}
          >
            Create
          </button>
        </div>
        {premises.length === 0 && (
          <p className="error">Create a premises first — an agent belongs to one.</p>
        )}
      </section>

      {downloaded && (
        <div className="notice">
          Downloaded <code>{downloaded}</code>. It contains a single-use enrollment token — treat it
          as a secret, and run it with administrator rights on the target machine.
        </div>
      )}

      {agents.length === 0 ? (
        <p className="empty">No agents yet.</p>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Agent</th><th>Premises</th><th>Version</th><th>Cameras</th>
              <th>Status</th><th>Transcodes</th><th>Installer</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.thingName}>
                <td>
                  <code>{agent.thingName}</code>
                  {agent.siteName && <div className="muted small">{agent.siteName}</div>}
                </td>
                <td>{agent.premisesId ?? '—'}</td>
                <td>{agent.agentVersion ?? <span className="muted">not enrolled</span>}</td>
                <td>{agent.cameraCount}</td>
                <td>
                  <span className={agent.online ? 'badge ok' : 'badge warn'}>
                    {agent.online ? 'online' : 'offline'}
                  </span>
                  {!agent.online && agent.disconnectReason && (
                    <div className="muted small">{agent.disconnectReason.toLowerCase().replace(/_/g, ' ')}</div>
                  )}
                  {agent.online && agent.health && !agent.health.healthy && (
                    // Connected but not working — the case presence events
                    // cannot see, and the reason the heartbeat exists.
                    <div className="muted small">failing: {agent.health.failingTasks.join(', ')}</div>
                  )}
                  {agent.online && agent.health && agent.health.publishing > 0 && (
                    <div className="muted small">{agent.health.publishing} streaming</div>
                  )}
                </td>
                <td>
                  <TranscodeLimit agent={agent} act={act} />
                </td>
                <td>
                  <div className="row tight">
                    <select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
                      {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                    <button className="btn" onClick={() => void act(async () => {
                      setDownloaded(await downloadInstaller(agent.thingName, platform));
                    })}>
                      Download
                    </button>
                    {agent.online && (
                      <button className="btn" onClick={() => void act(() => requestScan(agent.thingName))}>Scan now</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * How many renditions this agent will encode at once.
 *
 * Only the operator knows what the box can take, so the default is the
 * cautious one — an encode costs roughly a core per 1080p stream, and the
 * agent usually shares a small machine with whatever else it was bought for.
 * Zero is a legitimate setting: it means this site serves camera bytes only,
 * and viewers who need a transcode are told so rather than left waiting.
 */
function TranscodeLimit({ agent, act }: {
  agent: Agent;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [value, setValue] = useState(String(agent.maxConcurrentTranscodes ?? 1));
  const changed = value !== String(agent.maxConcurrentTranscodes ?? 1);

  return (
    <div className="row tight">
      <input
        type="number"
        min={0}
        max={64}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: '4.5rem' }}
        aria-label={`Concurrent transcodes for ${agent.thingName}`}
      />
      {changed && (
        <button className="btn" onClick={() => void act(async () => {
          await setTranscodeLimit(agent.thingName, Number(value));
        })}>
          Save
        </button>
      )}
    </div>
  );
}

function PremisesTab({ premises, agents, act }: {
  premises: Premises[];
  agents: Agent[];
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [premisesId, setPremisesId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [address, setAddress] = useState('');

  return (
    <div className="stack">
      <section className="card">
        <strong>Add a premises</strong>
        <p className="muted small">
          A site. Its id becomes part of every agent name and stream path there, so it cannot be
          changed afterwards — and it is what lets a viewer be restricted to one site.
        </p>
        <div className="row">
          <label className="field">
            Id
            <input value={premisesId} placeholder="acme-hq"
                   onChange={(e) => setPremisesId(e.target.value.toLowerCase())} />
          </label>
          <label className="field">
            Name
            <input value={displayName} placeholder="Acme HQ" onChange={(e) => setDisplayName(e.target.value)} />
          </label>
          <label className="field">
            Address
            <input value={address} onChange={(e) => setAddress(e.target.value)} />
          </label>
          <button className="btn"
            disabled={!premisesId}
            onClick={() => void act(async () => {
              await createPremises({ premisesId, displayName: displayName || premisesId, address });
              setPremisesId(''); setDisplayName(''); setAddress('');
            })}
          >
            Create
          </button>
        </div>
      </section>

      {premises.length === 0 ? (
        <p className="empty">No premises yet.</p>
      ) : (
        <table className="grid-table">
          <thead><tr><th>Name</th><th>Id</th><th>Address</th><th>Agents</th><th /></tr></thead>
          <tbody>
            {premises.map((site) => {
              const attached = agents.filter((a) => a.premisesId === site.premisesId).length;
              return (
                <tr key={site.premisesId}>
                  <td>{site.displayName}</td>
                  <td><code>{site.premisesId}</code></td>
                  <td>{site.address ?? '—'}</td>
                  <td>{attached}</td>
                  <td>
                    <button className="btn"
                      disabled={attached > 0}
                      title={attached > 0 ? 'Remove its agents first' : undefined}
                      onClick={() => void act(() => deletePremises(site.premisesId))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Users({ users, premises, me, act }: {
  users: AdminUser[];
  premises: Premises[];
  me: Me | null;
  act: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [scoped, setScoped] = useState<string[]>([]);
  return (
    <div className="stack">
      <section className="card">
        <strong>Invite a viewer</strong>
        <p className="muted small">They receive a temporary password by email and choose their own on first sign-in.</p>
        <div className="row">
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="viewer">Viewer — watch only</option>
              <option value="operator">Operator — premises, agents, cameras</option>
              <option value="admin">Admin — everything, including users</option>
              {me?.role === 'superadmin' && <option value="superadmin">Superadmin — all tenants</option>}
            </select>
          </label>
          <label className="field">
            Premises
            <select
              multiple
              size={Math.min(4, Math.max(2, premises.length))}
              value={scoped}
              onChange={(e) => setScoped(Array.from(e.target.selectedOptions, (o) => o.value))}
            >
              {premises.map((p) => (
                <option key={p.premisesId} value={p.premisesId}>{p.displayName}</option>
              ))}
            </select>
          </label>
          <button className="btn"
            disabled={!email}
            onClick={() => void act(async () => {
              await createUser({ email, role, premises: scoped });
              setEmail(''); setRole('viewer'); setScoped([]);
            })}
          >
            Invite
          </button>
        </div>
        <p className="muted small">
          Selecting no premises grants every site in the tenant. Choosing exactly one restricts that
          viewer's stream access to it; selecting several currently still grants the whole tenant,
          because a CloudFront cookie carries a single wildcard.
        </p>
      </section>

      <table className="grid-table">
        <thead><tr><th>Email</th><th>Role</th><th>Premises</th><th>Status</th><th /></tr></thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.username}>
              <td>{user.email ?? user.username}</td>
              <td><span className="badge">{user.role ?? 'viewer'}</span></td>
              <td className="muted small">{user.premises || 'all sites'}</td>
              <td><span className="muted">{user.status?.toLowerCase().replace(/_/g, ' ')}</span></td>
              <td>
                <button className="btn" onClick={() => void act(() => deleteUser(user.username))}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
