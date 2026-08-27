import { useEffect, useMemo } from 'react';
import type { Camera } from './api';

/**
 * Which slice of the estate the live view is showing.
 *
 * There is deliberately no "everything" option. A wall of cameras drawn from
 * every site at once is not a view anybody uses: the tiles have no relationship
 * to each other, "Lobby" appears a dozen times, and the operator has to read
 * every label to work out what they are looking at. A premises is the smallest
 * unit that means something on its own, so it is the smallest thing shown.
 */
export interface Scope {
  premisesId: string;
  /** null means every agent at this premises. */
  thingName: string | null;
}

export interface Place {
  premisesId: string;
  agents: { thingName: string; label: string }[];
  /** Cameras currently reachable here, which decides where to open. */
  online: number;
}

/** Premises, and the agents serving each, derived from the cameras themselves. */
export function placesOf(cameras: Camera[]): Place[] {
  const byPremises = new Map<string, Place>();

  for (const camera of cameras) {
    const premisesId = camera.premisesId ?? 'unassigned';
    let place = byPremises.get(premisesId);
    if (!place) {
      place = { premisesId, agents: [], online: 0 };
      byPremises.set(premisesId, place);
    }
    if (camera.online) place.online += 1;
    if (!place.agents.some((a) => a.thingName === camera.thingName)) {
      place.agents.push({
        thingName: camera.thingName,
        // The site name is what an operator recognises; the thing name's last
        // segment identifies the box when no site name has been set.
        label: camera.siteName || camera.thingName.split('--').pop() || camera.thingName,
      });
    }
  }

  const places = [...byPremises.values()];
  for (const place of places) place.agents.sort((a, b) => a.label.localeCompare(b.label));
  places.sort((a, b) => a.premisesId.localeCompare(b.premisesId));
  return places;
}

export function inScope(scope: Scope | null, camera: Camera): boolean {
  if (!scope) return false;
  if ((camera.premisesId ?? 'unassigned') !== scope.premisesId) return false;
  if (scope.thingName && camera.thingName !== scope.thingName) return false;
  return true;
}

/**
 * Keeps the selection valid as the estate changes underneath it.
 *
 * Cameras arrive after the first render and agents come and go, so a selection
 * made a moment ago can stop existing. Falling back to the first premises beats
 * showing an empty grid with a dropdown pointing at something that is gone.
 */
export function useResolvedScope(
  places: Place[],
  scope: Scope | null,
  setScope: (scope: Scope) => void,
) {
  useEffect(() => {
    if (places.length === 0) return;

    const place = scope && places.find((p) => p.premisesId === scope.premisesId);
    if (!place) {
      // Opens on somewhere with cameras actually running. Alphabetical order
      // would land an operator on a site that is entirely offline — a wall of
      // dead tiles as the first thing they see every morning, with the live
      // ones several selections away.
      const liveliest = places.find((p) => p.online > 0) ?? places[0];
      setScope({ premisesId: liveliest.premisesId, thingName: null });
      return;
    }
    // A premises served by exactly one agent has nothing to choose between, so
    // the choice is made rather than presented.
    if (place.agents.length === 1 && scope!.thingName !== place.agents[0].thingName) {
      setScope({ premisesId: place.premisesId, thingName: place.agents[0].thingName });
      return;
    }
    if (scope!.thingName && !place.agents.some((a) => a.thingName === scope!.thingName)) {
      setScope({ premisesId: place.premisesId, thingName: null });
    }
  }, [places, scope, setScope]);
}

export function ScopePicker({ cameras, scope, onScope }: {
  cameras: Camera[];
  scope: Scope | null;
  onScope: (scope: Scope) => void;
}) {
  const places = useMemo(() => placesOf(cameras), [cameras]);
  const place = scope ? places.find((p) => p.premisesId === scope.premisesId) : undefined;
  const agents = place?.agents ?? [];

  return (
    <div className="scope">
      <label className="scope-field">
        <span>Premises</span>
        <select
          className="control"
          value={scope?.premisesId ?? ''}
          // One premises is not a choice; showing it as one invites the
          // operator to look for alternatives that do not exist.
          disabled={places.length <= 1}
          onChange={(e) => onScope({ premisesId: e.target.value, thingName: null })}
        >
          {places.length === 0 && <option value="">No premises yet</option>}
          {places.map((p) => (
            <option key={p.premisesId} value={p.premisesId}>
              {p.premisesId}{p.online > 0 ? ` · ${p.online} live` : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="scope-field">
        <span>Agent</span>
        <select
          className="control"
          value={scope?.thingName ?? ''}
          disabled={agents.length <= 1}
          onChange={(e) => onScope({
            premisesId: scope!.premisesId,
            thingName: e.target.value || null,
          })}
        >
          {agents.length > 1 && <option value="">All agents ({agents.length})</option>}
          {agents.map((a) => (
            <option key={a.thingName} value={a.thingName}>{a.label}</option>
          ))}
          {agents.length === 0 && <option value="">No agents yet</option>}
        </select>
      </label>
    </div>
  );
}
