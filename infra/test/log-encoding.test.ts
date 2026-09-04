import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent's log must be UTF-8 wherever it runs.
 *
 * Java 21 defaults `file.encoding` to UTF-8, but not the console streams:
 * `System.err` still gets the host's native encoding, and on Windows that is
 * the ANSI codepage. The agent logs through SLF4J's SimpleLogger, which writes
 * to `System.err`, so on Windows an em-dash in a log message was written as a
 * single byte 0x97 - valid cp1252, invalid UTF-8.
 *
 * Found by reading a real log: `PROFILE_1694700208 <?> selecting the smallest
 * rendition instead`. The message was correct; the file was not decodable.
 * Anything that reads it as UTF-8 - grep, a log shipper, CloudWatch, a
 * support engineer opening it in an editor - sees a replacement character or
 * an outright decode error, on the exact lines that explain a fault.
 *
 * Linux happened to be correct already, which is the trap: the encoding was
 * inherited from whatever locale the host provided rather than chosen. A
 * systemd unit inherits no locale, so that was luck, not design. Setting it
 * explicitly at every launch site makes the log's encoding a property of the
 * agent instead of a property of the machine it landed on.
 */
const ROOT = join(__dirname, '..', '..');

/** Every place in the project that builds a command line to launch the jar. */
const LAUNCH_SITES = [
  ['packaging', 'linux', 'camstream-agent.service'],
  ['packaging', 'windows', 'camstream-agent.xml'],
  ['packaging', 'windows', 'install.ps1'],
];

describe('the agent writes UTF-8 logs everywhere it runs', () => {
  it.each(LAUNCH_SITES)('sets both stream encodings in %s/%s/%s', (...parts) => {
    const source = readFileSync(join(ROOT, ...parts), 'utf8');
    const launches = source.match(/-XX:MaxRAMPercentage=\d+[^\n]*?-jar/g) ?? [];

    // A launch site that stopped launching is a broken assumption, not a pass.
    expect(launches.length, 'expected at least one java invocation').toBeGreaterThan(0);

    for (const line of launches) {
      // stderr carries the log; stdout is set with it so the pair cannot drift.
      expect(line).toContain('-Dstderr.encoding=UTF-8');
      expect(line).toContain('-Dstdout.encoding=UTF-8');
    }
  });
});
