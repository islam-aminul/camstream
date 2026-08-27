import { describe, it, expect } from 'vitest';
import { resolveDesiredState, MAX_VISIBLE } from '../watch/index';

const NOW = 1_000;
const THING = 'demo--site--box';

/** An estate far larger than any one screen. */
const ESTATE = Array.from({ length: 400 }, (_, i) => ({
  thingName: THING,
  cameraId: `cam-${String(i).padStart(3, '0')}`,
  sourceCodec: 'h264',
  sourceCodecProfile: 'Main',
}));

function viewer(visible: string[], scope: string[] = []) {
  return {
    sk: 'DEMAND#s1',
    sessionId: 's1',
    visible: visible.map((id) => `${THING}/${id}`),
    codecs: ['h264'],
    transcode: [],
    scope,
    expiresAt: NOW + 10_000,
  };
}

describe('demand follows what is on screen', () => {
  it('publishes only the cameras a viewer is showing', () => {
    // The property that makes a large site affordable at all: every published
    // rendition is an ffmpeg process at the edge and S3 requests per segment,
    // so opening a page must not start four hundred of them.
    const [state] = resolveDesiredState(
      NOW,
      [viewer(['cam-004', 'cam-011'])],
      [{ thingName: THING }],
      ESTATE,
    );

    expect(state.renditions.map((r) => r.cameraId)).toEqual(['cam-004', 'cam-011']);
  });

  it('publishes nothing for a viewer showing nothing', () => {
    const [state] = resolveDesiredState(NOW, [viewer([])], [{ thingName: THING }], ESTATE);
    expect(state.renditions).toHaveLength(0);
  });

  it('refuses a camera the viewer named but the registry does not have', () => {
    // Otherwise a crafted request could make an agent dial an arbitrary
    // camera id, or simply spend its slots on nothing.
    const [state] = resolveDesiredState(
      NOW,
      [viewer(['cam-004', 'no-such-camera'])],
      [{ thingName: THING }],
      ESTATE,
    );

    expect(state.renditions.map((r) => r.cameraId)).toEqual(['cam-004']);
  });

  it('still refuses cameras outside the viewer’s premises', () => {
    const [state] = resolveDesiredState(
      NOW,
      [viewer(['cam-004'], ['other-site'])],
      [{ thingName: THING }],
      ESTATE,
    );

    expect(state.renditions).toHaveLength(0);
  });

  it('caps what one viewer can hold open', () => {
    expect(MAX_VISIBLE).toBeLessThanOrEqual(64);
  });
});

describe('reading an estate larger than one DynamoDB page', () => {
  it('follows the cursor until there is none', async () => {
    const { queryAllPages } = await import('../shared/registry');
    // DynamoDB caps a Query at 1MB and returns a cursor. A single Query reads
    // roughly three thousand camera records and then stops silently — the
    // caller sees a short list, not an error, and cameras vanish from the
    // console with nothing to say why.
    const pages = [
      { Items: [{ id: 1 }, { id: 2 }], LastEvaluatedKey: { sk: 'a' } },
      { Items: [{ id: 3 }], LastEvaluatedKey: { sk: 'b' } },
      { Items: [{ id: 4 }] },
    ];
    const seen: (Record<string, unknown> | undefined)[] = [];
    let call = 0;

    const all = await queryAllPages<{ id: number }>(
      async (input) => { seen.push(input.ExclusiveStartKey); return pages[call++]; },
      'table', 'TENANT#demo', 'LIVECAMERA#',
    );

    expect(all.map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([undefined, { sk: 'a' }, { sk: 'b' }]);
  });

  it('handles a single page without asking for another', async () => {
    const { queryAllPages } = await import('../shared/registry');
    let calls = 0;
    const all = await queryAllPages<{ id: number }>(
      async () => { calls++; return { Items: [{ id: 1 }] }; },
      'table', 'TENANT#demo', 'LIVECAMERA#',
    );
    expect(all).toHaveLength(1);
    expect(calls).toBe(1);
  });
});
