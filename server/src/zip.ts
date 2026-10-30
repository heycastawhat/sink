import { deflateRawSync } from "node:zlib";

/**
 * A zip archive built in memory: deflated entries (stored when deflate doesn't help), UTF-8 names, file times.
 * No zip64, so it's for archives under 4 GB, which a notes vault is.
 */
export class ZipWriter {
  private parts: Uint8Array[] = [];
  private central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;

  add(name: string, data: Uint8Array, mtime = new Date()) {
    const nameBytes = new TextEncoder().encode(name);
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = Bun.hash.crc32(data);
    // MS-DOS date and time, local, two-second steps.
    const time = (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1);
    const date = ((Math.max(mtime.getFullYear(), 1980) - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();
    const common = (v: DataView, at: number) => {
      v.setUint16(at, 20, true); // version needed
      v.setUint16(at + 2, 0x0800, true); // UTF-8 names
      v.setUint16(at + 4, stored ? 0 : 8, true);
      v.setUint16(at + 6, time, true);
      v.setUint16(at + 8, date, true);
      v.setUint32(at + 10, crc, true);
      v.setUint32(at + 14, body.length, true);
      v.setUint32(at + 18, data.length, true);
      v.setUint16(at + 22, nameBytes.length, true);
    };
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    common(lv, 4);
    local.set(nameBytes, 30);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); // made by
    common(dv, 6);
    dv.setUint32(42, this.offset, true);
    dir.set(nameBytes, 46);
    this.parts.push(local, body);
    this.central.push(dir);
    this.offset += local.length + body.length;
    this.count++;
  }

  /** The whole archive. */
  finish(): Blob {
    const size = this.central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, size, true);
    ev.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end], { type: "application/zip" });
  }
}
