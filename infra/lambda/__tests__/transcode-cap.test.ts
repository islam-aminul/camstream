import { describe, it, expect } from 'vitest';
import { resolveDesiredState } from '../watch/index';

const NOW = 1_000;
const LATER = NOW + 10_000;

const THING = 'demo--site--box';

/**
 * A viewer that can decode ordinary H.264 and nothing else — the common case.
 *
 * `visible` names the cameras actually on screen: demand follows what is being
 * shown, not the size of the estate.
 */
/**
 * Transcode demand is keyed "thingName/cameraId" — a bare camera id used to
 * start an encode on every agent in the tenant that had a camera of that name.
 */
const at = (cameraId: string) => `${THING}/${cameraId}`;

function viewer(sessionId: string, transcode: string[] = [], visible?: string[]) {
  const cameras = visible ?? ['one', 'two', 'three'];
  return {
    sk: `DEMAND#${sessionId}`,
    sessionId,
    visible: cameras.map((id) => `${THING}/${id}`),
    codecs: ['h264'],
    transcode: transcode.map(at),
    scope: [],
    expiresAt: LATER,
  };
}

const HEVC_CAMERAS = ['one', 'two', 'three'].map((id) => ({
  thingName: THING,
  cameraId: id,
  sourceCodec: 'hevc',
  sourceCodecProfile: 'Main',
}));

describe('holding an agent to its transcode limit', () => {
  it('runs one transcode by default and declines the rest', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', ['one', 'two', 'three'])],
      [{ thingName: THING }],
      HEVC_CAMERAS,
    );

    expect(state.renditions).toHaveLength(1);
    expect(state.renditions[0].cameraId).toBe('one');
    expect(state.declined?.map((d) => d.cameraId)).toEqual(['three', 'two']);
    expect(state.maxConcurrentTranscodes).toBe(1);
  });

  it('honours a limit an administrator raised', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', ['one', 'two', 'three'])],
      [{ thingName: 'demo--site--box', maxConcurrentTranscodes: 3 }],
      HEVC_CAMERAS,
    );

    expect(state.renditions).toHaveLength(3);
    expect(state.declined).toBeUndefined();
  });

  it('declines every transcode when the site is set not to transcode', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', ['one'])],
      [{ thingName: 'demo--site--box', maxConcurrentTranscodes: 0 }],
      HEVC_CAMERAS,
    );

    expect(state.renditions).toHaveLength(0);
    expect(state.declined).toHaveLength(1);
    expect(state.maxConcurrentTranscodes).toBe(0);
  });

  it('never lets an encode crowd out a stream copy', () => {
    // The failure that matters: one viewer opening HEVC cameras must not stop
    // the cheap cameras that were working perfectly well.
    const cameras = [
      ...HEVC_CAMERAS,
      { thingName: THING, cameraId: 'aaa-plain', sourceCodec: 'h264', sourceCodecProfile: 'Main' },
      { thingName: THING, cameraId: 'zzz-plain', sourceCodec: 'h264', sourceCodecProfile: 'High' },
    ];
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', ['one', 'two', 'three'], ['one', 'two', 'three', 'aaa-plain', 'zzz-plain'])],
      [{ thingName: THING }],
      cameras,
    );

    const copies = state.renditions.filter((r) => r.variant === 'source').map((r) => r.cameraId);
    expect(copies).toEqual(['aaa-plain', 'zzz-plain']);
    expect(state.renditions.filter((r) => r.variant === 'h264')).toHaveLength(1);
  });

  it('says nothing about limits when nothing was declined', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', [], ['one'])],
      [{ thingName: THING }],
      [{ thingName: THING, cameraId: 'one', sourceCodec: 'h264', sourceCodecProfile: 'Main' }],
    );

    expect(state.declined).toBeUndefined();
    expect(state.maxConcurrentTranscodes).toBeUndefined();
  });

  it('gives the slot to the same camera each time rather than flapping', () => {
    const run = () => resolveDesiredState(
      NOW,
      [viewer('s1', ['three', 'one', 'two'])],
      [{ thingName: THING }],
      HEVC_CAMERAS,
    )[0].renditions[0].cameraId;

    expect(run()).toBe(run());
  });
});

describe('who gets the slot when more than one wants it', () => {
  const withTimes = (
    sessionId: string,
    transcode: string[],
    transcodeSince: Record<string, number>,
  ) => ({
    sk: `DEMAND#${sessionId}`,
    sessionId,
    visible: ['aaa', 'zzz'].map((id) => `${THING}/${id}`),
    codecs: ['h264'],
    transcode: transcode.map(at),
    transcodeSince: Object.fromEntries(Object.entries(transcodeSince).map(([k, v]) => [at(k), v])),
    scope: [],
    expiresAt: LATER,
  });

  it('keeps the transcode that was asked for first', () => {
    // The bug this guards: slots were handed out by name, so requesting
    // "aaa" would evict "zzz" mid-playback even though somebody was watching
    // it. Observed live — a camera started, then stopped seconds later.
    const [state] = resolveDesiredState(
      NOW,
      [withTimes('s1', ['zzz', 'aaa'], { zzz: 100, aaa: 200 })],
      [{ thingName: THING }],
      [
        { thingName: THING, cameraId: 'aaa', sourceCodec: 'hevc' },
        { thingName: THING, cameraId: 'zzz', sourceCodec: 'hevc' },
      ],
    );

    expect(state.renditions.filter((r) => r.variant === 'h264').map((r) => r.cameraId))
      .toEqual(['zzz']);
    expect(state.declined?.map((d) => d.cameraId)).toEqual(['aaa']);
  });

  it('does not let a second viewer take the first one’s stream', () => {
    const [state] = resolveDesiredState(
      NOW,
      [
        withTimes('early', ['zzz'], { zzz: 100 }),
        withTimes('late', ['aaa'], { aaa: 500 }),
      ],
      [{ thingName: THING }],
      [
        { thingName: THING, cameraId: 'aaa', sourceCodec: 'hevc' },
        { thingName: THING, cameraId: 'zzz', sourceCodec: 'hevc' },
      ],
    );

    expect(state.renditions.filter((r) => r.variant === 'h264').map((r) => r.cameraId))
      .toEqual(['zzz']);
  });

  it('falls back to the name when nothing distinguishes them', () => {
    const [state] = resolveDesiredState(
      NOW,
      [withTimes('s1', ['zzz', 'aaa'], { zzz: 100, aaa: 100 })],
      [{ thingName: THING }],
      [
        { thingName: THING, cameraId: 'aaa', sourceCodec: 'hevc' },
        { thingName: THING, cameraId: 'zzz', sourceCodec: 'hevc' },
      ],
    );

    expect(state.renditions.filter((r) => r.variant === 'h264').map((r) => r.cameraId))
      .toEqual(['aaa']);
  });
});
