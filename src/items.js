// HEIF item graph: read the meta box, extract payloads, append new items.
//
// Handles the layouts iPhone cameras write (infe v2 with 16-bit ids, iloc v1
// with 32-bit offsets and no base offset, iref v0, ipma v0) and refuses wider
// variants with a plain message instead of corrupting them.
//
// Box conventions: `scan()` reports `from` at the first body byte — for a
// FullBox that is the version byte, so version = d[from], version/flags occupy
// d[from, from + 4), and the box payload starts at from + 4.

import { scan, find, u16, u32, pushU16, pushU32, pushType, box, full, cstring,
  readCString, concat } from "./box.js";

export class Unsupported extends Error {}

export function readGraph(d) {
  const top = scan(d, 0, d.length);
  const ftyp = find(top, "ftyp");
  const meta = find(top, "meta");
  const mdat = find(top, "mdat");
  if (!ftyp || !meta || !mdat) throw new Unsupported("缺少 ftyp/meta/mdat，不是相机直出的 HEIC");
  if (top.some((b) => !["ftyp", "meta", "mdat"].includes(b.type)))
    throw new Unsupported("顶层还有其他盒子，暂不支持");

  const kids = scan(d, meta.from + 4, meta.to);
  const iinf = find(kids, "iinf");
  const iloc = find(kids, "iloc");
  const iref = find(kids, "iref");
  const pitm = find(kids, "pitm");
  const iprp = find(kids, "iprp");
  const idat = find(kids, "idat");
  const grpl = find(kids, "grpl");
  if (!iinf || !iloc || !pitm || !iprp) throw new Unsupported("meta 里缺少 iinf/iloc/pitm/iprp");

  const primary = u16(d, pitm.from + 4);

  // ---- items (infe) ----
  const items = new Map();
  {
    const countSize = d[iinf.from] === 0 ? 2 : 4;
    for (const e of scan(d, iinf.from + 4 + countSize, iinf.to)) {
      if (e.type !== "infe") continue;
      const iv = d[e.from];
      if (iv !== 2 && iv !== 3) continue;
      const idSize = iv === 2 ? 2 : 4;
      let q = e.from + 4;
      const id = idSize === 2 ? u16(d, q) : u32(d, q);
      q += idSize + 2; // id + protection_index
      const type = String.fromCharCode(d[q], d[q + 1], d[q + 2], d[q + 3]);
      q += 4;
      const [name, q2] = readCString(d, q, e.to);
      let uri = null, contentType = null;
      if (type === "uri ") [uri] = readCString(d, q2, e.to);
      else if (type === "mime") [contentType] = readCString(d, q2, e.to);
      items.set(id, { id, type, name, uri, contentType });
    }
  }

  // ---- locations (iloc v0/v1) ----
  const locs = new Map();
  let layout;
  {
    const ver = d[iloc.from];
    if (ver !== 0 && ver !== 1)
      throw new Unsupported(`iloc 版本 ${ver}，暂只支持版本 0/1`);
    const offSize = d[iloc.from + 4] >> 4;
    const lenSize = d[iloc.from + 4] & 15;
    const baseSize = d[iloc.from + 5] >> 4;
    const idxSize = ver === 1 ? d[iloc.from + 5] & 15 : 0;
    layout = { ver, offSize, lenSize, baseSize, idxSize };
    let p = iloc.from + 8; // past version/flags, size nibbles, entry count
    const count = u16(d, iloc.from + 6);
    for (let i = 0; i < count; i++) {
      const id = u16(d, p); p += 2;
      let method = 0;
      if (ver === 1) { method = u16(d, p) & 15; p += 2; } // reserved + construction_method
      p += 2; // data_reference_index
      const base = baseSize ? get(d, p, baseSize) : 0; p += baseSize;
      const extentCount = u16(d, p); p += 2;
      const extents = [];
      for (let k = 0; k < extentCount; k++) {
        if (idxSize) p += idxSize;
        const offPos = p; const off = base + get(d, p, offSize); p += offSize;
        const lenPos = p; const len = get(d, p, lenSize); p += lenSize;
        extents.push({ off, len, offPos, lenPos });
      }
      locs.set(id, { id, method, extents });
    }
  }

  // ---- references (iref v0) ----
  const refs = [];
  if (iref) {
    if (d[iref.from] !== 0) throw new Unsupported("iref 版本 1（4 字节 id），暂不支持");
    for (const e of scan(d, iref.from + 4, iref.to)) {
      const from = u16(d, e.from);
      const n = u16(d, e.from + 2);
      const tos = [];
      for (let i = 0; i < n; i++) tos.push(u16(d, e.from + 4 + i * 2));
      refs.push({ type: e.type, from, tos });
    }
  }

  // ---- properties (ipco / ipma); iprp is a plain container ----
  const inner = scan(d, iprp.from, iprp.to);
  const ipco = find(inner, "ipco");
  const ipma = find(inner, "ipma");
  if (!ipco || !ipma) throw new Unsupported("iprp 里缺少 ipco/ipma");
  const props = scan(d, ipco.from, ipco.to)
    .map((e) => ({ type: e.type, raw: d.slice(e.at, e.to) }));
  const assoc = new Map();
  const ipmaVer = d[ipma.from];
  const ipmaFlags = u32(d, ipma.from) & 0xffffff;
  const wide = (ipmaFlags & 1) !== 0;
  {
    let p = ipma.from + 8; // past version/flags and entry_count
    const n = u32(d, ipma.from + 4);
    for (let i = 0; i < n; i++) {
      const id = ipmaVer === 0 ? u16(d, p) : u32(d, p);
      p += ipmaVer === 0 ? 2 : 4;
      const ac = d[p]; p += 1;
      const list = [];
      for (let k = 0; k < ac; k++) {
        const v = wide ? u16(d, p) : d[p];
        p += wide ? 2 : 1;
        list.push({ index: v & (wide ? 0x7fff : 0x7f), essential: (v & (wide ? 0x8000 : 0x80)) !== 0 });
      }
      assoc.set(id, list);
    }
  }

  // ---- group ids (grpl is a plain container of EntityToGroupBox) ----
  let maxGroup = 0;
  if (grpl) for (const e of scan(d, grpl.from, grpl.to))
    maxGroup = Math.max(maxGroup, u32(d, e.from + 4));

  return { d, ftyp, meta, mdat, kids, iinf, iloc, iref, iprp, ipco, ipma, idat,
    layout, ipmaVer, ipmaFlags, primary, items, locs, refs, props, assoc, maxGroup };
}

/** Payload of a single-extent item (method 0 from the file, method 1 from idat). */
export function payloadOf(g, id) {
  const loc = g.locs.get(id);
  if (!loc) throw new Unsupported(`找不到条目 ${id}`);
  if (loc.extents.length !== 1) throw new Unsupported(`条目 ${id} 不是单段存储，暂不支持`);
  const e = loc.extents[0];
  if (loc.method === 1) {
    if (!g.idat) throw new Unsupported(`条目 ${id} 声明 idat 存储但没有 idat`);
    return g.d.slice(g.idat.from + e.off, g.idat.from + e.off + e.len);
  }
  if (loc.method !== 0) throw new Unsupported(`条目 ${id} 存储方式 ${loc.method}，暂不支持`);
  return g.d.slice(e.off, e.off + e.len);
}

/** The auxC URN attached to an item, or null. */
export function auxUriOf(g, id) {
  for (const a of g.assoc.get(id) || []) {
    const p = g.props[a.index - 1];
    if (p && p.type === "auxC") {
      const [urn] = readCString(p.raw, 12, p.raw.length); // 8 box + 4 FullBox
      return urn;
    }
  }
  return null;
}

/** Raw property box of the given type attached to an item. */
export function propOf(g, id, type) {
  for (const a of g.assoc.get(id) || []) {
    const p = g.props[a.index - 1];
    if (p && p.type === type) return p.raw;
  }
  return null;
}

/**
 * Append items and rebuild the file (ftyp + meta + one fresh mdat).
 *
 * plan entries: { itemType, itemName?, itemUri?, contentType?, auxUrn?,
 *   links?: [{ type, tos: [id|key] }], props?: [rawBox], propEssential?: [bool],
 *   payload, key? }
 * Identical property boxes are stored once, matching how the camera shares one
 * ispe/pixi/hvcC set across a family of mattes. Every existing external payload
 * is carried into the new mdat with its offset rewritten; idat items are left
 * alone.
 */
export function attach(g, plan) {
  const d = g.d;

  let nextId = g.maxGroup;
  for (const id of g.items.keys()) nextId = Math.max(nextId, id);
  for (const r of g.refs) nextId = Math.max(nextId, r.from);
  const newIds = plan.map((_, i) => nextId + 1 + i);
  const resolve = (t) => {
    if (typeof t !== "string") return t;
    const i = plan.findIndex((s) => s.key === t);
    return i < 0 ? t : newIds[i];
  };

  // ---- shared property pool: byte-identical boxes stored once ----
  const extraProps = [];
  const propIndex = new Map();
  g.props.forEach((p, i) => propIndex.set(hex(p.raw), i + 1));
  const reserve = (raw) => {
    const h = hex(raw);
    if (propIndex.has(h)) return propIndex.get(h);
    const index = g.props.length + extraProps.length + 1;
    extraProps.push(raw);
    propIndex.set(h, index);
    return index;
  };
  const assocAdds = plan.map((s, i) => {
    const list = (s.props || []).map((raw, k) => ({
      index: reserve(raw), essential: (s.propEssential || [])[k] === true,
    }));
    if (s.auxUrn) {
      list.push({
        index: reserve(full("auxC", 0, 0, Uint8Array.from(cstring(s.auxUrn)))),
        essential: true,
      });
    }
    return { id: newIds[i], list };
  });

  // ---- infe boxes ----
  const infes = plan.map((s, i) => {
    const body = [2, 0, 0, 1];
    pushU16(body, newIds[i]);
    pushU16(body, 0); // protection_index
    pushType(body, s.itemType);
    body.push(...cstring(s.itemName || ""));
    body.push(...cstring(s.itemUri || s.contentType || ""));
    return box("infe", Uint8Array.from(body));
  });

  // ---- ipma rebuilt wholesale so the index width can grow past 127 ----
  // Items with no properties (styles/texture uri entries, mime sidecars) get
  // no ipma entry — native captures omit them too.
  const allAssoc = [...g.assoc.entries()].map(([id, list]) => ({ id, list }))
    .concat(assocAdds).filter((e) => e.list.length);
  const maxIndex = Math.max(1, ...allAssoc.flatMap((e) => e.list.map((l) => l.index)));
  const wideNow = maxIndex > 127;
  const flags = (g.ipmaFlags & ~1) | (wideNow ? 1 : 0);
  const ipmaBody = [g.ipmaVer, 0, 0, flags]; // version/flags (stripped again by full())
  pushU32(ipmaBody, allAssoc.length);
  for (const e of allAssoc) {
    if (g.ipmaVer === 0) pushU16(ipmaBody, e.id);
    else pushU32(ipmaBody, e.id);
    ipmaBody.push(e.list.length);
    for (const a of e.list) {
      const v = (a.essential ? (wideNow ? 0x8000 : 0x80) : 0) | a.index;
      if (wideNow) pushU16(ipmaBody, v);
      else ipmaBody.push(v);
    }
  }
  const newIpma = full("ipma", g.ipmaVer, flags, Uint8Array.from(ipmaBody.slice(4)));

  // ---- iref additions ----
  const refAdds = plan.flatMap((s, i) => (s.links || []).map((l) => {
    const body = [];
    pushU16(body, newIds[i]);
    pushU16(body, l.tos.length);
    for (const t of l.tos) pushU16(body, resolve(t));
    return box(l.type, Uint8Array.from(body));
  }));

  // ---- iloc additions (offsets patched once the meta size settles) ----
  const { offSize, lenSize, baseSize } = g.layout;
  const ilocAdds = plan.map((_, i) => {
    const body = [];
    pushU16(body, newIds[i]);
    if (g.layout.ver === 1) pushU16(body, 0); // reserved + construction_method
    pushU16(body, 0); // data_reference_index
    for (let j = 0; j < g.layout.baseSize; j++) body.push(0); // base_offset
    pushU16(body, 1); // extent_count
    pushSized(body, 0, offSize);
    pushSized(body, 0, lenSize);
    return Uint8Array.from(body);
  });

  // ---- new meta ----
  const iinfCountSize = d[g.iinf.from] === 0 ? 2 : 4;
  const iinfCount = iinfCountSize === 2 ? u16(d, g.iinf.from + 4) : u32(d, g.iinf.from + 4);
  const iinfFinal = box("iinf", concat([
    d.slice(g.iinf.from, g.iinf.from + 4), // version/flags
    countBytes(iinfCount + plan.length, iinfCountSize),
    d.slice(g.iinf.from + 4 + iinfCountSize, g.iinf.to),
    concat(infes),
  ]));
  const irefFinal = box("iref", concat([
    g.iref ? d.slice(g.iref.from, g.iref.from + 4) : Uint8Array.of(0, 0, 0, 0),
    g.iref ? d.slice(g.iref.from + 4, g.iref.to) : new Uint8Array(0),
    concat(refAdds),
  ]));
  const ilocFinal = box("iloc", concat([
    d.slice(g.iloc.from, g.iloc.from + 4), // version/flags
    d.slice(g.iloc.from + 4, g.iloc.from + 6), // offset/length/base/index nibbles
    u16Bytes(u16(d, g.iloc.from + 6) + plan.length),
    d.slice(g.iloc.from + 8, g.iloc.to),
    concat(ilocAdds),
  ]));
  const iprpFinal = box("iprp", concat(scan(d, g.iprp.from, g.iprp.to).map((k) =>
    (k.type === "ipco"
      ? box("ipco", concat([d.slice(g.ipco.from, g.ipco.to), concat(extraProps)]))
      : k.type === "ipma" ? newIpma : d.slice(k.at, k.to)))));
  const rebuilds = new Map([["iinf", iinfFinal], ["iref", irefFinal],
    ["iloc", ilocFinal], ["iprp", iprpFinal]]);
  const metaParts = [
    d.slice(g.meta.from, g.meta.from + 4),
    ...g.kids.map((k) => rebuilds.get(k.type) || d.slice(k.at, k.to)),
  ];
  // A plain single-image HEIC may have no iref at all; replacement alone would
  // drop every new reference, so append a fresh box when the plan needs one.
  if (!g.iref && refAdds.length) metaParts.push(irefFinal);
  const newMeta = box("meta", concat(metaParts));

  // ---- payloads: cm-0 singles in entry order, then the new ones ----
  const blobs = [];
  for (const loc of g.locs.values()) {
    if (loc.method !== 0) continue; // idat items keep their extents untouched
    blobs.push(payloadOf(g, loc.id));
  }
  for (const s of plan) blobs.push(s.payload);

  // ---- patch extent offsets inside the rebuilt iloc ----
  const metaMut = newMeta.slice();
  const ilocBox = find(scan(metaMut, 12, metaMut.length), "iloc");
  let p = ilocBox.from + 8;
  const entryCount = u16(metaMut, ilocBox.from + 6);
  let blobAt = 0;
  const placed = [];
  for (let i = 0; i < entryCount; i++) {
    const method = g.layout.ver === 1 ? u16(metaMut, p + 2) & 15 : 0;
    p += g.layout.ver === 1 ? 6 : 4; // id + (construction_method) + data_ref
    const basePos = p;
    p += baseSize;
    const extCount = u16(metaMut, p); p += 2;
    for (let k = 0; k < extCount; k++) {
      if (g.layout.idxSize) p += g.layout.idxSize;
      if (method === 0) {
        // The absolute offset moves into the extent field, so any base_offset
        // contribution must be zeroed to avoid double counting on the next read.
        if (baseSize) put(metaMut, basePos, 0, baseSize);
        const data = blobs[blobAt++];
        placed.push({ data, offPos: p, lenPos: p + offSize });
      }
      p += offSize + lenSize;
    }
  }

  const prefix = d.slice(0, g.ftyp.size); // ftyp is always the first box
  let cursor = prefix.length + newMeta.length + 8;
  for (const rec of placed) {
    put(metaMut, rec.offPos, cursor, offSize);
    put(metaMut, rec.lenPos, rec.data.length, lenSize);
    cursor += rec.data.length;
  }
  const head = [];
  pushU32(head, 8 + placed.reduce((a, r) => a + r.data.length, 0));
  pushType(head, "mdat");
  return concat([prefix, metaMut, Uint8Array.from(head),
    concat(placed.map((r) => r.data))]);
}

// ---- sized integers (1/2/3/4 bytes, big-endian) ----
function get(d, at, size) {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + d[at + i];
  return v;
}
function put(d, at, v, size) {
  for (let j = 0; j < size; j++) d[at + j] = Math.floor(v / 256 ** (size - 1 - j)) % 256;
}
function pushSized(out, v, size) {
  for (let j = 0; j < size; j++) out.push(Math.floor(v / 256 ** (size - 1 - j)) % 256);
}
function countBytes(v, size) {
  const out = [];
  pushSized(out, v, size);
  return Uint8Array.from(out);
}
const u16Bytes = (v) => Uint8Array.of(v >> 8 & 255, v & 255);
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
