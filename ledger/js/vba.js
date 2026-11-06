// Reads the macros' source out of a workbook's xl/vbaProject.bin, in the
// browser: the file is an OLE compound file (MS-CFB) whose VBA module
// streams are compressed (MS-OVBA 2.4.1). Nothing is run — the app only reads
// what the Print & Log PI macro writes where.
//
//   vbaModules(bytes) -> {Module1: 'Option Explicit …', …}

const ENDCHAIN = 0xfffffffe;

export function vbaModules(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (sig.some((b, i) => u8[i] !== b)) throw new Error('not an OLE file');
  const secSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const dirStart = dv.getUint32(0x30, true);
  const cutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  const difatStart = dv.getUint32(0x44, true);
  const difatCount = dv.getUint32(0x48, true);
  const sector = (n) => u8.subarray((n + 1) * secSize, (n + 2) * secSize);

  // the FAT: its sectors are listed in the header's DIFAT, then in DIFAT sectors
  const fatSectors = [];
  for (let i = 0; i < 109; i++) { const s = dv.getUint32(0x4c + i * 4, true); if (s < 0xfffffffa) fatSectors.push(s); }
  let d = difatStart;
  for (let k = 0; k < difatCount && d < 0xfffffffa; k++) {
    const sv = new DataView(u8.buffer, u8.byteOffset + (d + 1) * secSize, secSize);
    for (let i = 0; i < secSize / 4 - 1; i++) { const s = sv.getUint32(i * 4, true); if (s < 0xfffffffa) fatSectors.push(s); }
    d = sv.getUint32(secSize - 4, true);
  }
  const fat = [];
  for (const s of fatSectors) { const sv = new DataView(u8.buffer, u8.byteOffset + (s + 1) * secSize, secSize); for (let i = 0; i < secSize / 4; i++) fat.push(sv.getUint32(i * 4, true)); }
  const chain = (start) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== ENDCHAIN && s < fat.length && !seen.has(s); s = fat[s]) { seen.add(s); out.push(s); }
    return out;
  };
  const readChain = (start) => {
    const ids = chain(start);
    const out = new Uint8Array(ids.length * secSize);
    ids.forEach((s, i) => out.set(sector(s), i * secSize));
    return out;
  };

  // directory entries
  const dir = readChain(dirStart);
  const ddv = new DataView(dir.buffer);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const len = ddv.getUint16(off + 0x40, true);
    let name = '';
    for (let i = 0; i < Math.max(0, len / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(off + i * 2, true));
    entries.push({
      name, type: dir[off + 0x42], left: ddv.getUint32(off + 0x44, true), right: ddv.getUint32(off + 0x48, true),
      child: ddv.getUint32(off + 0x4c, true), start: ddv.getUint32(off + 0x74, true), size: ddv.getUint32(off + 0x78, true),
    });
  }
  const root = entries[0];
  const ministream = root ? readChain(root.start) : new Uint8Array(0);
  const minifat = [];
  if (miniFatStart < 0xfffffffa) {
    const m = readChain(miniFatStart);
    const mv = new DataView(m.buffer);
    for (let i = 0; i < m.length / 4; i++) minifat.push(mv.getUint32(i * 4, true));
  }
  const stream = (e) => {
    if (e.size < cutoff) {
      const out = new Uint8Array(e.size);
      let pos = 0;
      const seen = new Set();
      for (let s = e.start; s !== ENDCHAIN && pos < e.size && !seen.has(s); s = minifat[s]) {
        seen.add(s);
        const chunk = ministream.subarray(s * miniSize, (s + 1) * miniSize);
        out.set(chunk.subarray(0, Math.min(chunk.length, e.size - pos)), pos);
        pos += chunk.length;
      }
      return out;
    }
    return readChain(e.start).subarray(0, e.size);
  };
  // the streams inside a storage (a red-black tree of siblings under `child`)
  const children = (e) => {
    const out = [];
    const walk = (i) => {
      if (i === 0xffffffff || i >= entries.length) return;
      const x = entries[i];
      walk(x.left);
      out.push(x);
      walk(x.right);
    };
    walk(e.child);
    return out;
  };
  const findStorage = (from, name) => children(from).find((x) => x.name.toUpperCase() === name && (x.type === 1 || x.type === 5));
  const vbaDir = findStorage(root, 'VBA') || (() => {
    for (const x of children(root)) if (x.type === 1) { const y = findStorage(x, 'VBA'); if (y) return y; }
    return null;
  })();
  if (!vbaDir) return {};

  const text = (b) => {
    try { return new TextDecoder('windows-1252').decode(b); } catch { return String.fromCharCode(...b); }
  };
  const out = {};
  for (const e of children(vbaDir)) {
    if (e.type !== 2 || /^(dir|_VBA_PROJECT|__SRP_\d+|PROJECT.*)$/i.test(e.name)) continue;
    const s = stream(e);
    // the module's source is a compressed container near the end of the
    // stream (after the p-code): find the one that opens "Attribute VB_Name"
    for (let i = 0; i < s.length - 3; i++) {
      if (s[i] !== 1) continue;
      const h = s[i + 1] | (s[i + 2] << 8);
      if (((h >> 12) & 7) !== 3) continue;
      let src;
      try { src = text(decompress(s.subarray(i))); } catch { continue; }
      if (src.startsWith('Attribute VB_Name')) {
        out[e.name] = src.split(/\r?\n/).filter((l) => !/^Attribute VB_/.test(l)).join('\n');
        break;
      }
    }
  }
  return out;
}

// MS-OVBA 2.4.1: a CompressedContainer (signature 0x01, then 4 KB chunks)
export function decompress(c) {
  if (c[0] !== 1) throw new Error('not a compressed container');
  const out = [];
  let p = 1;
  while (p + 2 <= c.length) {
    const head = c[p] | (c[p + 1] << 8);
    const size = (head & 0x0fff) + 3;
    if (((head >> 12) & 7) !== 3) throw new Error('bad chunk');
    const end = Math.min(c.length, p + size);
    const start = out.length;
    p += 2;
    if (!(head & 0x8000)) {
      for (let i = 0; i < 4096 && p < end; i++) out.push(c[p++]);
      continue;
    }
    while (p < end) {
      const flags = c[p++];
      for (let bit = 0; bit < 8 && p < end; bit++) {
        if (!(flags & (1 << bit))) { out.push(c[p++]); continue; }
        const tok = c[p] | (c[p + 1] << 8);
        p += 2;
        const d = out.length - start;
        let bits = 4;
        while ((1 << bits) < d) bits++;
        bits = Math.min(12, Math.max(4, bits));
        const lenMask = 0xffff >> bits;
        const len = (tok & lenMask) + 3;
        const off = (tok >> (16 - bits)) + 1;
        if (off > out.length - start) throw new Error('bad copy token');
        for (let k = 0; k < len; k++) out.push(out[out.length - off]);
      }
    }
  }
  return Uint8Array.from(out);
}
