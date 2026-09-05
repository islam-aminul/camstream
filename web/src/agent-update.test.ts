import { describe, it, expect } from 'vitest';
import { updateRefusal } from './agent-update';

/**
 * Offering an Update that would do nothing is not a harmless button.
 *
 * Telling an agent to fetch the build it is already running downloads thirty
 * megabytes over a site's uplink and restarts the service to arrive exactly
 * where it started. On a site with one camera that restart is a gap in the only
 * recording anyone has.
 *
 * Until now the console could not tell: it showed what each agent reported but
 * had no idea what the current build was, so the only way to find out whether
 * an Update would change anything was to press it and watch. The listing now
 * carries the version an Update would install, which is a property of the
 * control plane rather than of any agent.
 */
const online = { online: true, agentVersion: '0.1.1' };

describe('offering an update', () => {
  it('is refused when the agent is already on the current build', () => {
    expect(updateRefusal(online, '0.1.1')).toBe('Already running 0.1.1, the current build');
  });

  it('is offered when a newer build exists', () => {
    expect(updateRefusal({ online: true, agentVersion: '0.1.0' }, '0.1.1')).toBeNull();
  });

  it('is refused when the agent is not connected', () => {
    // The instruction goes over MQTT. An offline agent will never hear it, and
    // the button would report success for something that did not happen.
    expect(updateRefusal({ online: false, agentVersion: '0.1.0' }, '0.1.1'))
      .toBe('The agent must be connected to be told');
  });

  it('prefers the connection complaint when both apply', () => {
    // "Already current" would be misleading about an agent nobody can reach:
    // it has not reported since, so what it is running is a guess.
    expect(updateRefusal({ online: false, agentVersion: '0.1.1' }, '0.1.1'))
      .toBe('The agent must be connected to be told');
  });

  it('is offered when the current build is unknown', () => {
    // Null is "the control plane has not said", not "not current". Hiding an
    // update that is needed is worse than offering one that is not - the first
    // leaves a site on an old build with no way to notice.
    expect(updateRefusal(online, null)).toBeNull();
  });

  it('is offered when the agent has never reported a version', () => {
    // An agent that has connected but never said what it runs is exactly the
    // one worth updating, and comparing null to a version must not read as a
    // match.
    expect(updateRefusal({ online: true, agentVersion: null }, '0.1.1')).toBeNull();
    expect(updateRefusal({ online: true }, '0.1.1')).toBeNull();
  });

  it('does not call two unknowns a match', () => {
    // Both absent is the state on the very first render: no page has loaded, so
    // the current build is unknown, and an agent that has never checked in has
    // no version either. A plain equality check calls that a match and refuses
    // the update with "Already running null" - which is both wrong and the
    // exact case where an update is most likely to be wanted.
    //
    // Every other null case survives a naive comparison, so this is the one
    // that holds the guards in place.
    expect(updateRefusal({ online: true, agentVersion: null }, null)).toBeNull();
    expect(updateRefusal({ online: true }, null)).toBeNull();
  });
});
