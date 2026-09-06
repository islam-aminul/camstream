import { describe, it, expect } from 'vitest';
import { updateRefusal, askedRefusal } from './agent-update';

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

/**
 * A second click is the expensive one.
 *
 * An update takes tens of seconds - fetch thirty megabytes, stage the jar,
 * exit, wait for the service manager - and for all of it the row on screen
 * still says connected and still says the old version, because nothing has
 * been reloaded. So the button looks exactly as clickable as it did before,
 * and the operator who is not sure the first click registered clicks again.
 *
 * That was observed: a double click on a live agent sent two update
 * instructions seconds apart. It was harmless only by luck - the second
 * arrived while the agent was down for its restart and IoT does not queue for
 * a disconnected device, so it was dropped. Had it landed a moment earlier it
 * would have reached an agent mid-download.
 *
 * The fix is not to remember the click for a while and hope. It is to refuse
 * until the page has something new to decide from, because that is the honest
 * statement of what this page knows.
 */
describe('after an update has been asked for', () => {
  it('refuses a second click on the same agent', () => {
    expect(updateRefusal({ online: true, agentVersion: '0.1.0' }, '0.1.1', true))
      .toBe(askedRefusal);
  });

  it('says to refresh rather than going silently grey', () => {
    // A disabled control with no reason invites the question the tooltip is
    // there to answer, and the answer here is an instruction: reload.
    expect(askedRefusal).toMatch(/refresh/i);
  });

  it('wins over every other reason, because the row is now stale', () => {
    // The agent is about to disconnect and about to change version, so both
    // other refusals are answering from fields that are known to be out of
    // date. Reporting "already running 0.1.1" here would be reporting the
    // update as complete before anything has confirmed it.
    expect(updateRefusal({ online: false, agentVersion: '0.1.0' }, '0.1.1', true))
      .toBe(askedRefusal);
    expect(updateRefusal({ online: true, agentVersion: '0.1.1' }, '0.1.1', true))
      .toBe(askedRefusal);
  });

  it('does not affect agents that were not asked', () => {
    // The flag is per agent. Disabling the whole column after one click would
    // stop an operator updating the rest of a site without a reload.
    expect(updateRefusal({ online: true, agentVersion: '0.1.0' }, '0.1.1', false)).toBeNull();
  });

  it('defaults to not-asked, so an omitted argument cannot disable a button', () => {
    // Every existing caller passes two arguments. If the default were true,
    // the whole column would be dead on first render and the page would look
    // broken rather than cautious.
    expect(updateRefusal({ online: true, agentVersion: '0.1.0' }, '0.1.1')).toBeNull();
  });
});
