/**
 * A minimal ZIP writer, for handing an operator one file instead of three.
 *
 * Stored, not deflated. The contents are a few kilobytes of text and a
 * compressed archive would save nothing worth the code — and STORE has no
 * dependency, which matters more here: this runs in a Lambda whose whole job
 * is to be small and to have nothing in it that needs patching.
 *
 * Deliberately not a general ZIP library. It writes exactly what the format
 * requires for a handful of small files with ASCII names, and nothing else:
 * no directories, no ZIP64, no encryption, no unicode path extras.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

/** Version 2.0: the floor that supports STORE with a data descriptor absent. */
const VERSION = 20;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time and date, which is what the format stores. */
function dosStamp(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    // Years are counted from 1980; anything earlier cannot be represented.
    date: ((Math.max(1980, when.getFullYear()) - 1980) << 9)
      | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

export interface ZipEntry {
  name: string;
  /** File content. Text is encoded UTF-8 by the caller. */
  data: Buffer;
  /**
   * Whether the file should be executable once extracted.
   *
   * Written into the external attributes as a Unix mode, which is what `unzip`
   * on Linux reads. Windows ignores it, which is correct: a .cmd is
   * executable there by extension.
   */
  executable?: boolean;
}

export function makeZip(entries: ZipEntry[], when = new Date()): Buffer {
  const { time, date } = dosStamp(when);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, name, entry.data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_HEADER, 0);
    // Version made by: 3 (Unix) in the high byte, so the mode below is read.
    dir.writeUInt16LE((3 << 8) | VERSION, 4);
    dir.writeUInt16LE(VERSION, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attributes
    // External attributes: the Unix mode sits in the high 16 bits.
    dir.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);

    central.push(dir, name);
    offset += local.length + name.length + entry.data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, directory, end]);
}
