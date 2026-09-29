// ISO-BMFF byte primitives: read box trees, build boxes.

/** Parse the top-level and nested box headers in d[from, to). */
export function scan(d, from, to) {
  const out = [];
  let p = from;
  while (p + 8 <= to) {
    const size32 = (d[p] << 24 | d[p + 1] << 16 | d[p + 2] << 8 | d[p + 3]) >>> 0;
    const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
    let size = size32, head = 8;
    if (size32 === 1) {
      if (p + 16 > to) break;
      size = Number(d.slice(p + 8, p + 16).reduce((a, b) => a * 256 + b, 0));
      head = 16;
    } else if (size32 === 0) {
      size = to - p;
    }
    if (size < head || p + size > to) break;
    out.push({ type, at: p, size, head, from: p + head, to: p + size });
    p += size;
  }
  return out;
}

export function find(boxes, type) {
  return boxes.find((b) => b.type === type) || null;
}

/** Body of a FullBox (skips its 4-byte version/flags). */
export function fullBody(b) {
  return { from: b.from + 4, to: b.to, version: b ? undefined : 0, box: b };
}

export function u16(d, p) { return d[p] << 8 | d[p + 1]; }
export function u32(d, p) { return (d[p] << 24 | d[p + 1] << 16 | d[p + 2] << 8 | d[p + 3]) >>> 0; }

export function pushU16(out, v) { out.push(v >> 8 & 255, v & 255); }
export function pushU32(out, v) {
  out.push(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
}
export function pushType(out, type) {
  for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
}

/** Box = size + type + payload. */
export function box(type, payload) {
  const out = [];
  pushU32(out, 8 + payload.length);
  pushType(out, type);
  out.push(...payload);
  return Uint8Array.from(out);
}

/** FullBox = size + type + version/flags + payload. */
export function full(type, version, flags, payload) {
  const head = [version, flags >> 16 & 255, flags >> 8 & 255, flags & 255];
  return box(type, Uint8Array.from([...head, ...payload]));
}

export function cstring(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  out.push(0);
  return out;
}

/** Read a NUL-terminated string starting at p; returns [string, next]. */
export function readCString(d, p, end) {
  let s = "";
  while (p < end && d[p] !== 0) s += String.fromCharCode(d[p++]);
  return [s, p < end ? p + 1 : p];
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
