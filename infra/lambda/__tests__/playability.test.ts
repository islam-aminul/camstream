import { describe, it, expect } from 'vitest';
import { canDecode, isUnplayableH264, transcodeWouldHelp } from '../shared/playability';

const EVERY_BROWSER = ['h264'];
const SAFARI = ['h264', 'hevc'];

describe('what a browser can actually decode', () => {
  it('treats ordinary H.264 as the universal floor', () => {
    expect(canDecode('h264', 'Main', EVERY_BROWSER)).toBe(true);
    expect(canDecode('h264', 'High', EVERY_BROWSER)).toBe(true);
    expect(canDecode('h264', 'Constrained Baseline', EVERY_BROWSER)).toBe(true);
    // Even a viewer reporting nothing at all: H.264 needs no probing.
    expect(canDecode('h264', 'High', [])).toBe(true);
  });

  it('refuses the H.264 profiles no browser decodes', () => {
    // The bug: these report codec_name "h264", so the camera looked playable,
    // was served its own bytes, and then decoded nothing.
    expect(canDecode('h264', 'High 10', EVERY_BROWSER)).toBe(false);
    expect(canDecode('h264', 'High 4:2:2', EVERY_BROWSER)).toBe(false);
    expect(canDecode('h264', 'High 4:4:4 Predictive', SAFARI)).toBe(false);
  });

  it('is not fooled by casing or stray whitespace from ffprobe', () => {
    expect(isUnplayableH264('H264', 'HIGH 10')).toBe(true);
    expect(isUnplayableH264('avc1', ' high 10 ')).toBe(true);
  });

  it('assumes an unknown profile is fine', () => {
    // Guessing the other way would transcode streams that never needed it, on
    // edge hardware that may have no encoder at all.
    expect(canDecode('h264', undefined, EVERY_BROWSER)).toBe(true);
    expect(canDecode('h264', 'Some Future Profile', EVERY_BROWSER)).toBe(true);
  });

  it('asks the viewer about anything that is not H.264', () => {
    expect(canDecode('hevc', 'Main', SAFARI)).toBe(true);
    expect(canDecode('hevc', 'Main', EVERY_BROWSER)).toBe(false);
  });
});

describe('whether transcoding is worth offering', () => {
  it('offers it for a stream the viewer cannot decode', () => {
    expect(transcodeWouldHelp('hevc', 'Main', EVERY_BROWSER)).toBe(true);
    // The case that used to be refused: H.264 that needs transcoding to H.264.
    expect(transcodeWouldHelp('h264', 'High 10', EVERY_BROWSER)).toBe(true);
  });

  it('does not offer it when the source already plays', () => {
    expect(transcodeWouldHelp('h264', 'Main', EVERY_BROWSER)).toBe(false);
    expect(transcodeWouldHelp('hevc', 'Main', SAFARI)).toBe(false);
  });

  it('does not offer it to a viewer that cannot decode the target either', () => {
    expect(transcodeWouldHelp('hevc', 'Main', [])).toBe(false);
    expect(transcodeWouldHelp('h264', 'High 10', ['vp9'])).toBe(false);
  });
});
