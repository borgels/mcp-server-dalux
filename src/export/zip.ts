import { open, type FileHandle } from 'node:fs/promises';
import * as zlib from 'node:zlib';

/**
 * Minimal streaming ZIP writer: entries are appended to a file one by one,
 * so only the entry being written is held in memory, and the central
 * directory is written on finish(). No ZIP64: the archive, every entry and
 * the entry count must stay below the classic ZIP limits, which the export
 * limits guarantee (see MAX_ZIP_BYTES and MAX_ZIP_ENTRIES).
 */

/** Largest archive size written (classic ZIP offsets are 32-bit). */
export const MAX_ZIP_BYTES = 0xffff_ffff - 64 * 1024 * 1024;
/** Largest number of entries (classic ZIP entry count is 16-bit). */
export const MAX_ZIP_ENTRIES = 0xffff;

export interface ZipEntryOptions {
  /** Deflate the entry (text); stored otherwise (photos are already compressed). */
  compress?: boolean;
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  method: number;
  offset: number;
}

export class ZipWriter {
  private offset = 0;
  private readonly records: CentralRecord[] = [];
  private readonly names = new Set<string>();
  private readonly dosTime: number;
  private readonly dosDate: number;

  /** The archive's bytes, when it is built in memory. */
  private readonly chunks: Uint8Array[] = [];

  private constructor(
    private readonly handle: FileHandle | undefined,
    modified: Date,
  ) {
    ({ time: this.dosTime, date: this.dosDate } = dosDateTime(modified));
  }

  /** Create (or truncate) `path` and start an archive whose entries carry `modified`. */
  static async create(path: string, modified: Date): Promise<ZipWriter> {
    return new ZipWriter(await open(path, 'w', 0o600), modified);
  }

  /**
   * Start an archive built in memory: nothing touches disk until the caller
   * has checked the finished bytes (`bytes()`) and writes them itself.
   */
  static memory(modified: Date): ZipWriter {
    return new ZipWriter(undefined, modified);
  }

  /** The complete archive built in memory, after finish(). */
  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Bytes written so far. */
  get size(): number {
    return this.offset;
  }

  /** Whether an entry with this name was already written. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  get entryCount(): number {
    return this.records.length;
  }

  async add(name: string, data: Uint8Array, options: ZipEntryOptions = {}): Promise<void> {
    if (this.names.has(name)) {
      throw new Error('Duplicate ZIP entry name.');
    }
    if (this.records.length >= MAX_ZIP_ENTRIES) {
      throw new Error('Too many ZIP entries.');
    }
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const body = options.compress ? zlib.deflateRawSync(data) : data;
    const method = options.compress ? 8 : 0;
    if (this.offset + 30 + nameBytes.length + body.byteLength > MAX_ZIP_BYTES) {
      throw new Error('ZIP archive size limit reached.');
    }

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(this.dosTime, 10);
    header.writeUInt16LE(this.dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.byteLength, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);

    const offset = this.offset;
    await this.write(header);
    await this.write(nameBytes);
    await this.write(body);
    this.names.add(name);
    this.records.push({ name: nameBytes, crc, compressedSize: body.byteLength, size: data.byteLength, method, offset });
  }

  /** Write the central directory and close the file. Returns the archive size. */
  async finish(): Promise<number> {
    const start = this.offset;
    for (const record of this.records) {
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(record.method, 10);
      entry.writeUInt16LE(this.dosTime, 12);
      entry.writeUInt16LE(this.dosDate, 14);
      entry.writeUInt32LE(record.crc, 16);
      entry.writeUInt32LE(record.compressedSize, 20);
      entry.writeUInt32LE(record.size, 24);
      entry.writeUInt16LE(record.name.length, 28);
      entry.writeUInt16LE(0, 30); // extra
      entry.writeUInt16LE(0, 32); // comment
      entry.writeUInt16LE(0, 34); // disk
      entry.writeUInt16LE(0, 36); // internal attributes
      entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
      entry.writeUInt32LE(record.offset, 42);
      await this.write(entry);
      await this.write(record.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await this.handle?.close();
    return this.offset;
  }

  /** Close the file without finishing the archive (the caller deletes it). */
  async abort(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.chunks.length = 0;
  }

  private async write(data: Uint8Array): Promise<void> {
    if (!this.handle) {
      this.chunks.push(data);
      this.offset += data.byteLength;
      return;
    }
    let written = 0;
    while (written < data.byteLength) {
      const { bytesWritten } = await this.handle.write(data, written, data.byteLength - written);
      written += bytesWritten;
    }
    this.offset += data.byteLength;
  }
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** zlib.crc32 exists from Node 22.2; the table version covers earlier 22.x. */
const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;

export function crc32(data: Uint8Array): number {
  if (nativeCrc32) {
    return nativeCrc32(data) >>> 0;
  }
  return tableCrc32(data);
}

export function tableCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
