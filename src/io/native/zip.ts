export interface ZipMember {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
  compression: number;
  encrypted: boolean;
  directory: boolean;
}

interface ZipEntry extends ZipMember {
  flags: number;
  crc: number;
  start: number;
}

export interface ZipArchive {
  members: readonly ZipMember[];
  read(path: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>>;
}

const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_TRAILING_PADDING = 1024 * 1024;
const MAX_MEMBERS = 4096;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const magic = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  return magic === 0x04034b50 || magic === 0x06054b50 || magic === 0x08074b50;
}

export function zipArchive(bytes: Uint8Array, padded = false): ZipArchive {
  if (bytes.length > MAX_ARCHIVE) throw new Error("ZIP archive exceeds 256 MiB.");
  if (bytes.length < 22) throw new Error("ZIP end-of-directory record is missing.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => {
    const size = view.getBigUint64(at, true);
    if (size > BigInt(MAX_ARCHIVE)) throw new Error("ZIP64 field exceeds the archive size limit.");
    return Number(size);
  };

  let lastNonzero = bytes.length - 1;
  if (padded) {
    while (lastNonzero >= 0 && bytes[lastNonzero] === 0 && bytes.length - lastNonzero <= MAX_TRAILING_PADDING + 22) {
      lastNonzero--;
    }
  }
  let end = bytes.length - 22;
  const lower = Math.max(0, end - 65535 - (padded ? MAX_TRAILING_PADDING : 0));
  for (; end >= lower; end--) {
    if (u32(end) !== 0x06054b50) continue;
    const recordEnd = end + 22 + u16(end + 20);
    if (recordEnd === bytes.length || (padded && recordEnd <= bytes.length &&
      recordEnd > lastNonzero && bytes.length - recordEnd <= MAX_TRAILING_PADDING)) break;
  }
  if (end < lower) throw new Error("ZIP end-of-directory record is missing or truncated.");
  if (u16(end + 4) !== 0 || u16(end + 6) !== 0 || u16(end + 8) !== u16(end + 10)) {
    throw new Error("Multi-disk ZIP archives are unsupported.");
  }
  let count = u16(end + 10);
  let size = u32(end + 12);
  let offset = u32(end + 16);
  let directoryEnd = end;
  if (end >= 20 && u32(end - 20) === 0x07064b50) {
    const record = u64(end - 12);
    if (u32(end - 16) !== 0 || u32(end - 4) !== 1 || record + 56 > end - 20 ||
      u32(record) !== 0x06064b50 || u32(record + 16) !== 0 || u32(record + 20) !== 0 ||
      record + 12 + u64(record + 4) !== end - 20 || u64(record + 24) !== u64(record + 32)) {
      throw new Error("ZIP64 directory locator is invalid or multi-disk.");
    }
    count = u64(record + 32);
    size = u64(record + 40);
    offset = u64(record + 48);
    directoryEnd = record;
  }
  if (count > MAX_MEMBERS || offset + size !== directoryEnd) throw new Error("ZIP central directory is invalid or too large.");

  const entries = new Map<string, ZipEntry>();
  const intervals: { start: number; end: number }[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directoryEnd || u32(at) !== 0x02014b50) throw new Error("ZIP central member record is invalid.");
    const flags = u16(at + 8);
    const compression = u16(at + 10);
    const crc = u32(at + 16);
    let compressedBytes = u32(at + 20);
    let uncompressedBytes = u32(at + 24);
    const nameLength = u16(at + 28);
    const extra = at + 46 + nameLength;
    const extraEnd = extra + u16(at + 30);
    const next = extraEnd + u16(at + 32);
    if (next > directoryEnd || nameLength === 0 || nameLength > 4096 || u16(at + 34) !== 0) {
      throw new Error("ZIP central member fields are invalid.");
    }
    let local = u32(at + 42);
    const name = bytes.subarray(at + 46, extra);
    const path = flags & 0x800 ? UTF8.decode(name) : new TextDecoder("ibm866").decode(name);
    if (/[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith("/") ||
      path.replace(/\/$/, "").split("/").some((part) => part === "." || part === ".." || !part) || entries.has(path)) {
      throw new Error("ZIP member has an unsafe or duplicate path.");
    }
    if (!(flags & 0x800) && name.some((byte) => byte >= 128)) {
      throw new Error("ZIP members with non-ASCII names must declare UTF-8.");
    }
    if ([compressedBytes, uncompressedBytes, local].includes(0xffffffff)) {
      let field = extra;
      while (field + 4 <= extraEnd && u16(field) !== 1) field += 4 + u16(field + 2);
      if (field + 4 > extraEnd || field + 4 + u16(field + 2) > extraEnd) {
        throw new Error("ZIP64 member extra field is missing or invalid.");
      }
      const limit = field + 4 + u16(field + 2);
      field += 4;
      const readSize = () => {
        if (field + 8 > limit) throw new Error("ZIP64 member extra field is incomplete.");
        const value = u64(field);
        field += 8;
        return value;
      };
      if (uncompressedBytes === 0xffffffff) uncompressedBytes = readSize();
      if (compressedBytes === 0xffffffff) compressedBytes = readSize();
      if (local === 0xffffffff) local = readSize();
    }
    if (local + 30 > offset || u32(local) !== 0x04034b50 || u16(local + 6) !== flags ||
      u16(local + 8) !== compression || u16(local + 26) !== nameLength ||
      name.some((byte, index) => bytes[local + 30 + index] !== byte)) {
      throw new Error("ZIP local member header disagrees with the central directory.");
    }
    const start = local + 30 + nameLength + u16(local + 28);
    const finish = start + compressedBytes;
    if (finish > offset) throw new Error("ZIP member data extends into the central directory.");
    if (!(flags & 8)) {
      const localCompressed = u32(local + 18);
      const localUncompressed = u32(local + 22);
      if (u32(local + 14) !== crc || (localCompressed !== 0xffffffff && localCompressed !== compressedBytes) ||
        (localUncompressed !== 0xffffffff && localUncompressed !== uncompressedBytes)) {
        throw new Error("ZIP local member sizes or CRC disagree with the central directory.");
      }
    }
    const encrypted = !!(flags & 0x2041);
    const directory = path.endsWith("/");
    entries.set(path, { path, compressedBytes, uncompressedBytes, compression, encrypted, directory, flags, crc, start });
    intervals.push({ start: local, end: finish });
    at = next;
  }
  if (at !== directoryEnd) throw new Error("ZIP central directory member count disagrees with its size.");
  intervals.sort((left, right) => left.start - right.start);
  if (intervals.some((entry, index) => index > 0 && intervals[index - 1]!.end > entry.start)) {
    throw new Error("ZIP member data overlaps another local member.");
  }

  return {
    members: Array.from(entries.values(), ({ flags, crc, start, ...member }) => member),
    async read(path, maxBytes) {
      const member = entries.get(path);
      if (!member || member.directory) throw new Error("ZIP member was not found.");
      if (member.encrypted) throw new Error("Encrypted ZIP members are unsupported.");
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || member.uncompressedBytes > maxBytes) {
        throw new Error("ZIP member exceeds the extraction limit.");
      }
      const data = bytes.slice(member.start, member.start + member.compressedBytes);
      const result = member.compression === 0 ? data : member.compression === 8
        ? await inflate(data, member.uncompressedBytes)
        : undefined;
      if (!result) throw new Error("ZIP member uses unsupported compression.");
      if (result.length !== member.uncompressedBytes || crc32(result) !== member.crc) {
        throw new Error("ZIP member failed its size or CRC-32 integrity check.");
      }
      return result;
    },
  };
}

async function inflate(data: Uint8Array<ArrayBuffer>, size: number): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const result = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > size) throw new Error("ZIP member expanded beyond its declared size.");
      result.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (offset !== size) throw new Error("ZIP member expanded to less than its declared size.");
  return result;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, initial) => {
  let crc = initial;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
