import fs from 'node:fs';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crcUpdate = (crc, buf) => { for (let i = 0; i < buf.length; i++) crc = TABLE[(crc ^ buf[i]) & 255] ^ (crc >>> 8); return crc; };
const crcFile = f => new Promise((ok, no) => { let crc = 0xFFFFFFFF, size = 0; fs.createReadStream(f).on('data', d => { crc = crcUpdate(crc, d); size += d.length; }).on('end', () => ok({ crc: (crc ^ 0xFFFFFFFF) >>> 0, size })).on('error', no); });

// ZIP без сжатия (MP4 уже сжат): каждый клип — отдельный файл внутри архива.
export async function zipTo(res, files) {
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  const meta = [];
  for (const f of files) meta.push({ ...f, ...(await crcFile(f.path)), name: Buffer.from(f.name) });
  let off = 0;
  const write = b => new Promise(r => { off += b.length; res.write(b) ? r() : res.once('drain', r); });
  for (const m of meta) {
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(dt, 10); h.writeUInt16LE(dd, 12);
    h.writeUInt32LE(m.crc, 14); h.writeUInt32LE(m.size, 18); h.writeUInt32LE(m.size, 22); h.writeUInt16LE(m.name.length, 26);
    m.off = off; await write(Buffer.concat([h, m.name]));
    await new Promise((ok, no) => { const rs = fs.createReadStream(m.path); rs.on('data', c => { off += c.length; if (!res.write(c)) { rs.pause(); res.once('drain', () => rs.resume()); } }); rs.on('end', ok); rs.on('error', no); res.on('close', () => rs.destroy()); });
  }
  const cdStart = off;
  for (const m of meta) {
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(dt, 12); c.writeUInt16LE(dd, 14);
    c.writeUInt32LE(m.crc, 16); c.writeUInt32LE(m.size, 20); c.writeUInt32LE(m.size, 24); c.writeUInt16LE(m.name.length, 28); c.writeUInt32LE(m.off, 42);
    await write(Buffer.concat([c, m.name]));
  }
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(meta.length, 8); e.writeUInt16LE(meta.length, 10); e.writeUInt32LE(off - cdStart, 12); e.writeUInt32LE(cdStart, 16);
  res.end(e);
}
