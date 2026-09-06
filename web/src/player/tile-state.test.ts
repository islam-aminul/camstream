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
    const v = view({ reported: false, agentOnline: true, agentHasReported: true });
    expect(v.status).toBe('unreported');
    expect(v.message).toContain('credentials');
  });

  it('blames the agent when the agent is offline, not the camera', () => {
    // This assertion used to say the opposite - that unreported took
    // precedence over the agent being offline - and that was the bug.
    //
    // On 2026-09-06 an agent came back from a laptop suspend unable to obtain
    // AWS credentials. It reported nothing for twenty-six minutes, and every
    // camera on the site told the operator to check its cabling and its
    // password. One of them had been streaming all night. Nothing was wrong
    // with any camera, and the console sent somebody to look at all of them.
    //
    // An offline agent explains every tile beneath it. Saying anything about
    // the camera first is guessing, and guessing wrong is expensive: it is a
    // drive to a site to check a camera that is fine.
    const v = view({ reported: false, agentOnline: false });
    expect(v.status).toBe('offline');
    expect(v.message).toContain('agent is not connected');
    expect(v.message).not.toContain('credentials');
  });

  it('says wait, not fault, while the agent is still starting up', () => {
    // Every update restarts an agent, and for about thirty seconds afterwards
    // it has connected but not finished its first discovery sweep - so it has
    // reported nothing and every one of its cameras is unreported. Measured
    // at 09:36 on 2026-09-06: cameraCount read 0 and settled to 1 half a
    // minute later, with nothing wrong at all.
    //
    // Telling somebody to check a camera during a window that clears itself is
    // how a console teaches people to ignore it.
    const v = view({ reported: false, agentOnline: true, agentHasReported: false });
    expect(v.status).toBe('unreported');
    expect(v.message).toContain('starting up');
    expect(v.message).not.toContain('credentials');
  });

  it('does check the camera once the agent has looked and not found it', () => {
    // The one case the original message was right about, and the only one in
    // which it is worth anyone's time. The agent is connected, it has
    // reported, and this camera was not in what it reported: it looked, and
    // did not find it.
    const v = view({ reported: false, agentOnline: true, agentHasReported: true });
    expect(v.message).toContain('reachable');
    expect(v.message).toContain('credentials');
  });

  it('does not assert a fault when the agent state is unknown', () => {
    // agentHasReported is undefined against a control plane that does not send
    // agents yet. Unknown must not become an accusation - but it must still
    // say something useful, so it falls back to the checkable advice rather
    // than to silence.
    const v = view({ reported: false, agentOnline: true, agentHasReported: undefined });
    expect(v.status).toBe('unreported');
    expect(v.message).toContain('credentials');
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
