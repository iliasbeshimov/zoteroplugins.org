import { crc32, deflateRawSync } from "node:zlib";
import type { RangeReader } from "../../src/census/xpi.ts";

/** Minimal zip writer for synthetic .xpi fixtures (stored or deflated entries, no zip64). */
export function buildZip(files: Record<string, string | Uint8Array>, deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const body = deflate ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const count = Object.keys(files).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

/** A RangeReader over an in-memory buffer that records every request it serves. */
export function memoryReader(buf: Uint8Array): RangeReader & { requests: [number, number][] } {
  const requests: [number, number][] = [];
  const read = async (start: number, end: number) => {
    requests.push([start, end]);
    return buf.subarray(start, Math.min(end + 1, buf.length));
  };
  return Object.assign(read, { requests });
}
