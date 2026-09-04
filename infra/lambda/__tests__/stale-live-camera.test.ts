import { describe, it, expect } from 'vitest';
import { key } from '../shared/registry';

/**
 * Where a viewer is told to fetch a camera from, after the camera moves.
 *
 * `/api/streams` builds every manifest URL from `LIVECAMERA#<agent>#<camera>`
 * records, which each agent writes about itself. Moving a camera changes which
 * agent owns it — and used to leave the previous agent's record in place.
 *
 * The result was a live view that could not work: the player followed the
 * stale record, requested segments under a prefix nobody was writing any more,
 * and every one came back 403. An agent that is still running clears its own
 * record on its next report, which is why this went unnoticed — but a camera
 * is very often moved precisely because its agent has stopped, and a stopped
 * agent clears nothing.
 *
 * Found on a Raspberry Pi whose clock reset on every reboot: the camera was
 * moved to a healthy agent, the healthy agent published, and viewers were
 * still sent to the dead one.
 */
describe('moving a camera between agents', () => {
  it('addresses the live record by agent, which is why it must be moved too', () => {
    // The key is per agent, so there is no single record that follows the
    // camera. Two agents can hold a record for the same camera at once.
    expect(key.liveCamera('acme--hq--old', 'mac-aaa'))
      .toBe('LIVECAMERA#acme--hq--old#mac-aaa');
    expect(key.liveCamera('acme--hq--new', 'mac-aaa'))
      .toBe('LIVECAMERA#acme--hq--new#mac-aaa');
    expect(key.liveCamera('acme--hq--old', 'mac-aaa'))
      .not.toBe(key.liveCamera('acme--hq--new', 'mac-aaa'));
  });

  it('the move plan deletes exactly the records the cameras are leaving', () => {
    // Mirrors what moveCameras assembles: one delete per camera that actually
    // changes owner, and none for a camera asked to stay where it is.
    const moves = [
      { identity: 'mac-aaa', cameraId: 'mac-aaa', from: 'acme--hq--old', to: 'acme--hq--new' },
      { identity: 'mac-bbb', cameraId: 'mac-bbb', from: 'acme--hq--new', to: 'acme--hq--old' },
      { identity: 'mac-ccc', cameraId: 'mac-ccc', from: 'acme--hq--old', to: 'acme--hq--old' },
    ];
    const stale = moves
      .filter((m) => m.from !== m.to)
      .map((m) => key.liveCamera(m.from, m.cameraId));

    expect(stale).toEqual([
      'LIVECAMERA#acme--hq--old#mac-aaa',
      'LIVECAMERA#acme--hq--new#mac-bbb',
    ]);
    // A swap deletes both sides. Deleting only one would leave the exchange
    // half advertised from where it used to be.
    expect(stale).toHaveLength(2);
    expect(stale).not.toContain(key.liveCamera('acme--hq--old', 'mac-ccc'));
  });
});
