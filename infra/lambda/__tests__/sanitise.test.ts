import { describe, it, expect } from 'vitest';
import { label, ipAddress, macAddress, oneOf, bounded, base64Key } from '../shared/sanitise';

const CONTROL = String.fromCharCode(0, 7, 27, 31, 127);

describe('label', () => {
  it('keeps ordinary device names intact', () => {
    expect(label('CP_Plus_Wi-Fi_camera')).toBe('CP_Plus_Wi-Fi_camera');
    expect(label('  Reception  ')).toBe('Reception');
  });

  it('bounds what a camera can push into the record', () => {
    // A single ONVIF response could otherwise carry a record past DynamoDB's
    // 400KB item limit.
    expect(label('x'.repeat(5000))!.length).toBe(128);
    expect(label('x'.repeat(5000), 64)!.length).toBe(64);
  });

  it('strips control characters rather than storing them', () => {
    // Left in, they make logs and the admin console lie about the value.
    expect(label(`Rec${CONTROL}eption`)).toBe('Reception');
  });

  it('rejects anything that is not a usable string', () => {
    for (const bad of [undefined, null, 42, {}, [], '', '   ', CONTROL]) {
      expect(label(bad)).toBeUndefined();
    }
  });
});

describe('ipAddress', () => {
  it('accepts real addresses', () => {
    expect(ipAddress('192.168.0.113')).toBe('192.168.0.113');
    expect(ipAddress(' 10.0.0.1 ')).toBe('10.0.0.1');
  });

  it('rejects malformed or out-of-range values', () => {
    for (const bad of ['192.168.0.999', '192.168.0', 'localhost', '1.2.3.4.5', '', 42]) {
      expect(ipAddress(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('macAddress', () => {
  it('accepts the agent normalised form', () => {
    expect(macAddress('AA:BB:CC:DD:EE:FF')).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('rejects other spellings and rubbish', () => {
    for (const bad of ['aa-bb-cc-dd-ee-ff', 'aabbccddeeff', 'not-a-mac', '']) {
      expect(macAddress(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('oneOf', () => {
  const states = ['UNKNOWN', 'AUTHENTICATED'] as const;

  it('passes a known value through', () => {
    expect(oneOf('AUTHENTICATED', states, 'UNKNOWN')).toBe('AUTHENTICATED');
  });

  it('falls back rather than storing whatever arrived', () => {
    expect(oneOf('PWNED', states, 'UNKNOWN')).toBe('UNKNOWN');
    expect(oneOf(undefined, states, 'UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('bounded', () => {
  it('accepts sensible dimensions', () => {
    expect(bounded(1920, 1, 16384)).toBe(1920);
    expect(bounded(25.4, 1, 1000)).toBe(25);
  });

  it('rejects out-of-range and non-finite values', () => {
    for (const bad of [0, 99999, -1, NaN, Infinity, '1920', null]) {
      expect(bounded(bad, 1, 16384), String(bad)).toBeUndefined();
    }
  });
});

describe('base64Key', () => {
  it('accepts a plausible key', () => {
    expect(base64Key('A'.repeat(392), 64, 2048)).toBe('A'.repeat(392));
  });

  it('rejects the wrong size or alphabet', () => {
    expect(base64Key('A'.repeat(10), 64, 2048)).toBeUndefined();
    expect(base64Key('A'.repeat(5000), 64, 2048)).toBeUndefined();
    expect(base64Key('not base64!', 5, 2048)).toBeUndefined();
  });
});
