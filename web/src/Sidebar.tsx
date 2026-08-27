import { useMemo, useState } from 'react';
import type { Camera } from './api';

/**
 * What the sidebar is currently narrowing the view to.
 *
 * `null` means the whole estate. A premises without an agent means every
 * camera at that site, whichever agent happens to serve it — which is how an
 * operator thinks about a building, and not how the thing names are shaped.
 */
export interface Scope {
  premisesId: string | null;
  thingName: string | null;
}

export const WHOLE_ESTATE: Scope = { premisesId: null, thingName: null };

export function scopeMatches(scope: Scope, camera: Camera): boolean {
  if (scope.thingName && camera.thingName !== scope.thingName) return false;
  if (scope.premisesId && (camera.premisesId ?? null) !== scope.premisesId) return false;
  return true;
}

interface Group {
  premisesId: string;
  label: string;
  cameras: number;
  online: number;
  agents: { thingName: string; label: string; cameras: number; online: number }[];
}

/**
 * Premises, then the agents within them.
 *
 * Two levels is the right depth: an operator navigates to a building, and only
 * then cares which box serves it — usually when something is wrong with one.
 * Cameras themselves belong in the grid, not the tree, because at this scale a
 * list of a thousand names is not navigation.
 */
function group(cameras: Camera[]): Group[] {
  const byPremises = new Map<string, Group>();

  for (const camera of cameras) {
    const premisesId = camera.premisesId ?? 'unassigned';
    let entry = byPremises.get(premisesId);
    if (!entry) {
      entry = { premisesId, label: premisesId, cameras: 0, online: 0, agents: [] };
      byPremises.set(premisesId, entry);
    }
    entry.cameras += 1;
    if (camera.online) entry.online += 1;

    let agent = entry.agents.find((a) => a.thingName === camera.thingName);
    if (!agent) {
      // The site name is what an operator recognises; the thing name is only a
      // fallback, and its last segment is the part that identifies the box.
      agent = {
        thingName: camera.thingName,
        label: camera.siteName || camera.thingName.split('--').pop() || camera.thingName,
        cameras: 0,
        online: 0,
      };
      entry.agents.push(agent);
    }
    agent.cameras += 1;
    if (camera.online) agent.online += 1;
  }

  const groups = [...byPremises.values()];
  for (const entry of groups) entry.agents.sort((a, b) => a.label.localeCompare(b.label));
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

export function Sidebar({ cameras, scope, onScope }: {
  cameras: Camera[];
  scope: Scope;
  onScope: (scope: Scope) => void;
}) {
  const groups = useMemo(() => group(cameras), [cameras]);
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (premisesId: string) =>
    setExpanded((open) => open.includes(premisesId)
      ? open.filter((id) => id !== premisesId)
      : [...open, premisesId]);

  const online = cameras.filter((c) => c.online).length;

  return (
    <nav className="sidebar" aria-label="Estate">
      <div className="sidebar-section">Estate</div>
      <button
        type="button"
        className={`tree-row${scope.premisesId === null && scope.thingName === null ? ' active' : ''}`}
        onClick={() => onScope(WHOLE_ESTATE)}
      >
        <span className="tree-caret" />
        <span className="tree-label">All cameras</span>
        <span className="tree-count">{online}/{cameras.length}</span>
      </button>

      <div className="sidebar-section">Premises</div>
      {groups.length === 0 && <div className="tree-row"><span className="tree-label muted">None yet</span></div>}

      {groups.map((entry) => {
        const open = expanded.includes(entry.premisesId);
        const activeHere = scope.premisesId === entry.premisesId && !scope.thingName;
        return (
          <div key={entry.premisesId}>
            <button
              type="button"
              className={`tree-row${activeHere ? ' active' : ''}`}
              onClick={() => {
                onScope({ premisesId: entry.premisesId, thingName: null });
                // Selecting a site reveals its agents: the next question after
                // "this building" is nearly always "which box".
                if (!open) toggle(entry.premisesId);
              }}
            >
              <span
                className={`tree-caret${open ? ' open' : ''}`}
                onClick={(e) => { e.stopPropagation(); toggle(entry.premisesId); }}
              >
                ▶
              </span>
              <span className="tree-label">{entry.label}</span>
              <span className="tree-count">{entry.online}/{entry.cameras}</span>
            </button>

            {open && entry.agents.map((agent) => (
              <button
                key={agent.thingName}
                type="button"
                className={`tree-row child${scope.thingName === agent.thingName ? ' active' : ''}`}
                onClick={() => onScope({ premisesId: entry.premisesId, thingName: agent.thingName })}
              >
                <span className={`dot ${agent.online > 0 ? 'ok' : 'off'}`} />
                <span className="tree-label">{agent.label}</span>
                <span className="tree-count">{agent.online}/{agent.cameras}</span>
              </button>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
