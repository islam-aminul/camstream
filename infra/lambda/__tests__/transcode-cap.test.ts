import { describe, it, expect } from 'vitest';
import { resolveDesiredState } from '../watch/index';

const NOW = 1_000;
const LATER = NOW + 10_000;

/** A viewer that can decode ordinary H.264 and nothing else — the common case. */
function viewer(sessionId: string, transcode: string[] = []) {
  return {
    sk: `DEMAND#${sessionId}`,
    sessionId,
    grid: true,
    codecs: ['h264'],
    transcode,
    scope: [],
    expiresAt: LATER,
  };
}

const HEVC_CAMERAS = ['one', 'two', 'three'].map((id) => ({
  thingName: 'demo--site--box',
  cameraId: id,
  sourceCodec: 'hevc',
  sourceCodecProfile: 'Main',
}));

describe('holding an agent to its transcode limit', () => {
  it('runs one transcode by default and declines the rest', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', ['one', 'two', 'three'])],
      [{ thingName: 'demo--site--box' }],
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
      { thingName: 'demo--site--box', cameraId: 'aaa-plain', sourceCodec: 'h264', sourceCodecProfile: 'Main' },
      { thingName: 'demo--site--box', cameraId: 'zzz-plain', sourceCodec: 'h264', sourceCodecProfile: 'High' },
    ];
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1', ['one', 'two', 'three'])],
      [{ thingName: 'demo--site--box' }],
      cameras,
    );

    const copies = state.renditions.filter((r) => r.variant === 'source').map((r) => r.cameraId);
    expect(copies).toEqual(['aaa-plain', 'zzz-plain']);
    expect(state.renditions.filter((r) => r.variant === 'h264')).toHaveLength(1);
  });

  it('says nothing about limits when nothing was declined', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer('s1')],
      [{ thingName: 'demo--site--box' }],
      [{ thingName: 'demo--site--box', cameraId: 'one', sourceCodec: 'h264', sourceCodecProfile: 'Main' }],
    );

    expect(state.declined).toBeUndefined();
    expect(state.maxConcurrentTranscodes).toBeUndefined();
  });

  it('gives the slot to the same camera each time rather than flapping', () => {
    const run = () => resolveDesiredState(
      NOW,
      [viewer('s1', ['three', 'one', 'two'])],
      [{ thingName: 'demo--site--box' }],
      HEVC_CAMERAS,
    )[0].renditions[0].cameraId;

    expect(run()).toBe(run());
  });
});
