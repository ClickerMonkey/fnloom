/**
 * Zip files over `node:zlib`: what system packages and data exports are made of. Writing is deterministic (entries in
 * the order given, deflated, every timestamp 1980-01-01, UTF-8 names), so packing the same files twice gives the same
 * bytes. Reading takes what common tools write (stored or deflated entries, data descriptors) and refuses what it
 * can't read safely: encrypted entries, zip64, other methods, a bad checksum, or more bytes than the limit.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/** One file in a zip: its path inside (forward slashes) and its bytes. */
export interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Why a zip couldn't be read. */
export class ZipError extends Error {
  override readonly name = 'ZipError';
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END_SIZE = 22;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const STORED = 0;
const DEFLATED = 8;
const VERSION = 20;
/** 1980-01-01 00:00 in DOS date and time. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const ZIP64_MARK = 0xffffffff;

/** Make a zip of `entries`, in order. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = deflateRawSync(entry.bytes);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(END_SIZE);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** Read every file of a zip (folders are skipped), refusing more than `maxBytes` unpacked in all. */
export function unzip(bytes: Uint8Array, maxBytes: number): ZipEntry[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  if (at === ZIP64_MARK || count === 0xffff) { throw new ZipError('zip64 archives are not supported'); }
  const out: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) { throw new ZipError('the zip directory is damaged'); }
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const path = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/')) { continue; }
    if ((flags & ENCRYPTED_FLAG) !== 0) { throw new ZipError(`${path} is encrypted`); }
    if (packed === ZIP64_MARK || size === ZIP64_MARK || local === ZIP64_MARK) { throw new ZipError('zip64 archives are not supported'); }
    total += size;
    if (total > maxBytes) { throw new ZipError(`the zip unpacks to more than ${maxBytes} bytes`); }
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL) { throw new ZipError(`the entry for ${path} is damaged`); }
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + packed);
    if (data.length !== packed) { throw new ZipError(`${path} is cut short`); }
    const file = method === STORED ? data : method === DEFLATED ? inflate(data, size, path) : undefined;
    if (file === undefined) { throw new ZipError(`${path} uses compression method ${method}, which isn't supported`); }
    if (file.length !== size || crc32(file) !== crc) { throw new ZipError(`${path} doesn't match its checksum`); }
    out.push({ path, bytes: new Uint8Array(file) });
  }
  return out;
}

/** Inflate one entry, never past its declared size. */
function inflate(data: Buffer, size: number, path: string): Buffer {
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
  } catch {
    throw new ZipError(`${path} can't be unpacked`);
  }
}

/** Where the end-of-directory record starts (searched back over a comment of up to 64 KiB). */
function findEnd(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - END_SIZE - 0xffff);
  for (let at = buffer.length - END_SIZE; at >= lowest; at -= 1) {
    if (buffer.readUInt32LE(at) === END) { return at; }
  }
  throw new ZipError('this is not a zip file');
}
