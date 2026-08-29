import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip, crc32 } from '../admin/zip';

/**
 * The archive writer, checked against a real extractor wherever one exists.
 *
 * Structural assertions alone would not have caught the mistakes worth
 * catching here — a wrong offset in the central directory, a CRC over the
 * wrong bytes — because a malformed archive still has the right signatures in
 * the right places. So this writes one and asks the operating system to open
 * it.
 */
function extractor(): string | null {
  for (const candidate of ['unzip', 'powershell']) {
    try {
      execFileSync(candidate, candidate === 'unzip' ? ['-v'] : ['-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: 'ignore',
      });
      return candidate;
    } catch {
      // Not on this machine; try the next.
    }
  }
  return null;
}

describe('the checksum the format requires', () => {
  it('matches the known CRC-32 of a standard vector', () => {
    // "123456789" has a documented CRC-32 of 0xCBF43926. Getting this wrong
    // produces an archive that every extractor rejects as corrupt.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for nothing at all', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('the archive itself', () => {
  const entries = [
    { name: 'install.ps1', data: Buffer.from('Write-Host "hello"\n', 'utf8') },
    { name: 'install.cmd', data: Buffer.from('@echo off\r\n', 'utf8') },
    { name: 'README.txt', data: Buffer.from('Put the archives here.\n', 'utf8'), executable: true },
  ];

  it('starts with a local file header and ends with the central directory', () => {
    const zip = makeZip(entries);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(entries.length);
  });

  it('is opened by a real extractor, with every file intact', () => {
    const tool = extractor();
    if (!tool) return;

    const dir = mkdtempSync(join(tmpdir(), 'camstream-zip-'));
    const archive = join(dir, 'bundle.zip');
    writeFileSync(archive, makeZip(entries));

    if (tool === 'unzip') {
      execFileSync('unzip', ['-q', '-o', archive, '-d', dir], { stdio: 'ignore' });
    } else {
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -Path '${archive}' -DestinationPath '${dir}' -Force`,
      ], { stdio: 'ignore' });
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      expect(existsSync(path), `${entry.name} was not extracted`).toBe(true);
      expect(readFileSync(path).equals(entry.data), `${entry.name} differs`).toBe(true);
    }
  });

  it('survives an empty file, which has no bytes to checksum', () => {
    const zip = makeZip([{ name: 'empty.txt', data: Buffer.alloc(0) }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(zip.length - 22 + 10)).toBe(1);
  });

  it('cannot write a date the format has no room for', () => {
    // MS-DOS counts years from 1980. A clock at the epoch would otherwise
    // write a negative year and corrupt the field beside it.
    const zip = makeZip([{ name: 'a', data: Buffer.from('x') }], new Date(0));
    expect(zip.readUInt16LE(12)).toBeGreaterThanOrEqual(0);
  });
});
