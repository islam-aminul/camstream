import { describe, it, expect } from 'vitest';
import { canDecode, transcodeWouldHelp, probeCodecs } from './playability';

describe('whether the browser can play what the camera sends', () => {
  it('treats ordinary H.264 as the universal floor', () => {
    expect(canDecode('h264', 'Main', [])).toBe(true);
    expect(canDecode('h264', 'High', [])).toBe(true);
  });

  it('refuses the H.264 profiles that no browser decodes', () => {
    // The failure this exists for: a camera emitting High 10 calls itself
    // "H.264" in its own web UI, was served its own bytes, played nothing, and
    // was then told no other rendition would help.
    expect(canDecode('h264', 'High 10', ['h264'])).toBe(false);
    expect(canDecode('h264', 'High 4:2:2', ['h264'])).toBe(false);
  });

  it('treats an unknown profile as playable rather than transcoding on a guess', () => {
    // Guessing the other way spends the operator's CPU on hardware that may
    // have no encoder at all.
    expect(canDecode('h264', 'Constrained Baseline', [])).toBe(true);
  });

  it('needs anything else to be in what the browser reported', () => {
    expect(canDecode('hevc', 'Main', ['h264'])).toBe(false);
    expect(canDecode('hevc', 'Main', ['h264', 'hevc'])).toBe(true);
  });
});

describe('whether transcoding would help', () => {
  it('does not offer a transcode for something already playable', () => {
    expect(transcodeWouldHelp('h264', 'Main', ['h264'])).toBe(false);
  });

  it('offers one when the source is undecodable and H.264 is not', () => {
    expect(transcodeWouldHelp('hevc', 'Main', ['h264'])).toBe(true);
    expect(transcodeWouldHelp('h264', 'High 10', ['h264'])).toBe(true);
  });

  it('does not offer one to a browser that could not play the result either', () => {
    expect(transcodeWouldHelp('hevc', 'Main', [])).toBe(false);
  });
});

describe('what this browser reports', () => {
  it('names codecs the way the agent does', () => {
    const codecs = probeCodecs((mime) => mime.includes('avc1') || mime.includes('hvc1'));
    expect(codecs).toContain('h264');
    expect(codecs).toContain('hevc');
    expect(codecs).not.toContain('av1');
  });

  it('claims H.264 even when the probe denies it', () => {
    // Claiming less than the floor asks the edge to transcode H.264 into
    // H.264 — cost for nothing, on hardware that is already the bottleneck.
    expect(probeCodecs(() => false)).toEqual(['h264']);
  });

  it('falls back to the floor when the browser has no MediaSource', () => {
    expect(probeCodecs(undefined)).toEqual(['h264']);
  });

  it('survives a probe that throws', () => {
    expect(probeCodecs(() => { throw new Error('nope'); })).toEqual(['h264']);
  });
});
