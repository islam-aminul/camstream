import { describe, it, expect } from 'vitest';
import { tileView, AGENT_STREAM_CEILING, type TileInput } from './tile-state';

const base: TileInput = {
  reported: true,
  agentOnline: true,
  sourceCodec: 'h264',
  sourceCodecProfile: 'Main',
  viewerCodecs: ['h264'],
  transcodeRequested: false,
  demanded: true,
  declined: false,
  playing: false,
};

const view = (over: Partial<TileInput> = {}) => tileView({ ...base, ...over });

describe('a tile that is showing nothing says why', () => {
  it('names the agent when the agent is the problem', () => {
    expect(view({ agentOnline: false })).toMatchObject({ status: 'offline' });
    expect(view({ agentOnline: false }).message).toContain('agent is not connected');
  });

  it('separates starting from stalled', () => {
    // The same black rectangle: one is normal and one is not.
    expect(view({ demanded: true }).status).toBe('starting');
    expect(view({ demanded: true }).message).toContain('Starting');
    expect(view({ demanded: false }).message).toContain('Waiting for the site');
  });

  it('says nothing at all once a frame is on screen', () => {
    expect(view({ playing: true })).toEqual({ status: 'live', message: '', offerTranscode: false });
  });
});

describe('a camera the agent has never reported', () => {
  it('appears, and says what to check', () => {
    // It has no manifest and no codec, so every other branch would be reading
    // fields that are not there. It still has to be on screen: an operator
    // waiting for a camera that will never arrive needs the reason.
    const v = view({ reported: false, agentOnline: false });
    expect(v.status).toBe('unreported');
    expect(v.message).toContain('credentials');
  });

  it('takes precedence over the agent being offline', () => {
    expect(view({ reported: false, agentOnline: false }).status).toBe('unreported');
  });
});

describe('a camera this browser cannot decode', () => {
  it('offers the conversion, and says what it costs', () => {
    const v = view({ sourceCodec: 'hevc', sourceCodecProfile: 'Main' });
    expect(v.status).toBe('undecodable');
    expect(v.offerTranscode).toBe(true);
    expect(v.message).toContain('H.265');
    // Never started silently: it spends the operator's own CPU.
    expect(v.message).toContain('CPU at the site');
  });

  it('recognises the H.264 that is not really H.264', () => {
    const v = view({ sourceCodecProfile: 'High 10' });
    expect(v.status).toBe('undecodable');
    expect(v.message).toContain('H.264 High 10');
    expect(v.offerTranscode).toBe(true);
  });

  it('does not offer a conversion that would not help', () => {
    const v = view({ sourceCodec: 'av1', sourceCodecProfile: null, viewerCodecs: [] });
    expect(v.offerTranscode).toBe(false);
    expect(v.message).toContain('would not help');
  });
});

describe('when the site runs out of the capacity to serve it', () => {
  it('names the transcode limit and what to do about it', () => {
    // The user's requirement, in the place it is felt: concurrency is bounded
    // by the hardware at the site, and the operator has to be told which
    // hardware and which limit.
    const v = view({
      sourceCodec: 'hevc', transcodeRequested: true, declined: true, maxConcurrentTranscodes: 2,
    });
    expect(v.status).toBe('declined');
    expect(v.message).toContain('converts 2 streams at a time');
    expect(v.message).toContain('Close another converted camera');
  });

  it('reads correctly when the limit is one', () => {
    const v = view({
      sourceCodec: 'hevc', transcodeRequested: true, declined: true, maxConcurrentTranscodes: 1,
    });
    expect(v.message).toContain('converts 1 stream at a time');
  });

  it('still says something useful when the agent did not name its limit', () => {
    const v = view({ sourceCodec: 'hevc', transcodeRequested: true, declined: true });
    expect(v.status).toBe('declined');
    expect(v.message).toContain('no spare capacity');
  });

  it('reports the hard stream ceiling as a reason to split the site', () => {
    const v = view({ agentStreams: AGENT_STREAM_CEILING });
    expect(v.status).toBe('capacity');
    expect(v.message).toContain('128');
    expect(v.message).toContain('another agent');
  });

  it('leaves the ceiling alone below it', () => {
    expect(view({ agentStreams: AGENT_STREAM_CEILING - 1 }).status).toBe('starting');
  });
});

describe('which reason wins', () => {
  it('reports the agent being offline before anything else', () => {
    // Everything below it is a consequence, and telling an operator to close a
    // converted camera when the agent is unplugged wastes their time.
    const v = view({
      agentOnline: false, sourceCodec: 'hevc', declined: true, agentStreams: 999,
    });
    expect(v.status).toBe('offline');
  });

  it('asks about decoding before it reports capacity', () => {
    // A viewer who has not asked for a conversion is not owed a lecture about
    // conversion slots.
    const v = view({ sourceCodec: 'hevc', declined: true, transcodeRequested: false });
    expect(v.status).toBe('undecodable');
  });
});
