import { describe, it, expect } from 'vitest';
import { resolveDesiredState } from '../watch/index';
import { withinScope } from '../shared/tenant';

/**
 * A restricted viewer must not learn the shape of the estate.
 *
 * `/api/watch` returned its whole computed desired state to the caller. The
 * scope check was applied when deciding what to publish but not to what came
 * back, so a viewer confined to one site received the thing name of every
 * agent in the tenant — and a thing name is `<tenant>--<premises>--<device>`,
 * so it names the sites too — along with the cameras other viewers had open
 * at them.
 */
describe('what /api/watch tells a premises-scoped viewer', () => {
  const NOW = 1_000;

  const devices = [
    { thingName: 'demo--acme-hq--gate' },
    { thingName: 'demo--secret-site--box' },
  ];
  const cameras = [
    { thingName: 'demo--acme-hq--gate', cameraId: 'cam-a', sourceCodec: 'h264', sourceCodecProfile: 'Main' },
    { thingName: 'demo--secret-site--box', cameraId: 'cam-b', sourceCodec: 'h264', sourceCodecProfile: 'Main' },
  ];
  const demands = [
    {
      sk: 'DEMAND#s1', sessionId: 's1',
      visible: ['demo--acme-hq--gate/cam-a'],
      codecs: ['h264'], transcode: [], scope: ['acme-hq'], expiresAt: NOW + 10_000,
    },
    // An unrestricted colleague, watching the site the first viewer may not see.
    {
      sk: 'DEMAND#s2', sessionId: 's2',
      visible: ['demo--secret-site--box/cam-b'],
      codecs: ['h264'], transcode: [], scope: [], expiresAt: NOW + 10_000,
    },
  ];

  /** What the handler serialises, once the response is scoped to the caller. */
  const responseFor = (scope: string[]) =>
    resolveDesiredState(NOW, demands, devices, cameras)
      .filter((state) => withinScope(state.thingName, scope));

  it('names only the caller’s own site', () => {
    expect(responseFor(['acme-hq']).map((s) => s.thingName)).toEqual(['demo--acme-hq--gate']);
  });

  it('does not reveal what is being watched elsewhere', () => {
    const serialised = JSON.stringify(responseFor(['acme-hq']));
    expect(serialised).not.toContain('secret-site');
    expect(serialised).not.toContain('cam-b');
  });

  it('still drives every agent, because the agents are not the caller', () => {
    // The narrowing is on the response only. An agent whose last viewer left
    // must still be told to stop, so the full set has to survive upstream.
    expect(resolveDesiredState(NOW, demands, devices, cameras).map((s) => s.thingName))
      .toEqual(['demo--acme-hq--gate', 'demo--secret-site--box']);
  });

  it('gives an unrestricted viewer the whole tenant', () => {
    expect(responseFor([]).map((s) => s.thingName))
      .toEqual(['demo--acme-hq--gate', 'demo--secret-site--box']);
  });
});
