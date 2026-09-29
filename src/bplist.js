// Binary plist (bplist00) writer — just the types the textureInfo payload needs:
// dict, ASCII string, integer, real, boolean, data.

import { concat } from "./box.js";

class Real {
  constructor(v) { this.v = v; }
}

/** Tag a number to pack as a plist REAL (JS cannot tell 1 from 1.0). */
export const real = (v) => new Real(v);

/** Build a bplist from an array of [key, value] pairs (insertion order kept). */
export function build(entries) {
  const objects = [];
  const interned = new Map();

  const add = (v) => {
    if (typeof v === "string") {
      if (interned.has(v)) return interned.get(v);
      const i = objects.push({ kind: "str", v }) - 1;
      interned.set(v, i);
      return i;
    }
    if (v instanceof Real) return objects.push({ kind: "real", v: v.v }) - 1;
    if (typeof v === "boolean") return objects.push({ kind: "bool", v }) - 1;
    if (typeof v === "number") return objects.push({ kind: "int", v }) - 1;
    if (v instanceof Uint8Array) return objects.push({ kind: "data", v }) - 1;
    if (Array.isArray(v)) {
      const self = objects.push({ kind: "arr", refs: [] }) - 1;
      objects[self].refs = v.map(add);
      return self;
    }
    throw new Error(`cannot pack ${typeof v} into a plist`);
  };

  const root = objects.push({ kind: "dict", keys: [], vals: [] }) - 1;
  objects[root].keys = entries.map(([k]) => add(k));
  objects[root].vals = entries.map(([, v]) => add(v));

  const enc = objects.map((o) => {
    switch (o.kind) {
      case "bool": return Uint8Array.of(o.v ? 0x09 : 0x08);
      case "int": {
        const v = o.v;
        if (v >= 0 && v < 0x100) return Uint8Array.of(0x10, v);
        if (v >= 0 && v < 0x10000) return Uint8Array.of(0x11, v >> 8, v & 255);
        if (v >= 0 && v < 0x100000000)
          return Uint8Array.of(0x12, v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
        const b = new Uint8Array(9); b[0] = 0x13;
        new DataView(b.buffer).setBigInt64(1, BigInt(v));
        return b;
      }
      case "real": {
        const b = new Uint8Array(9); b[0] = 0x23;
        new DataView(b.buffer).setFloat64(1, o.v);
        return b;
      }
      case "str": {
        const body = [];
        for (let i = 0; i < o.v.length; i++) body.push(o.v.charCodeAt(i) & 255);
        return o.v.length < 15
          ? Uint8Array.from([0x50 | o.v.length, ...body])
          : Uint8Array.from([0x5f, 0x10, o.v.length, ...body]);
      }
      case "data":
        return concat([Uint8Array.of(0x40 | Math.min(o.v.length, 14)), o.v]);
      case "arr":
        return concat([Uint8Array.of(0xa0 | Math.min(o.refs.length, 14)),
          ...o.refs.map((r) => Uint8Array.of(r))]);
      case "dict": {
        const head = Uint8Array.of(0xd0 | Math.min(o.keys.length, 14));
        return concat([head,
          ...o.keys.map((r) => Uint8Array.of(r)),
          ...o.vals.map((r) => Uint8Array.of(r))]);
      }
      default: throw new Error(`unreachable kind ${o.kind}`);
    }
  });

  // The payload this project writes is tiny: every ref fits in one byte and the
  // offset table below 256 bytes.
  const header = Uint8Array.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30]); // "bplist00"
  const offsets = [];
  let p = header.length;
  for (const e of enc) { offsets.push(p); p += e.length; }
  const tableAt = p;
  const table = Uint8Array.from(offsets);
  const trailer = new Uint8Array(32);
  trailer[6] = 1; // offset size
  trailer[7] = 1; // ref size
  new DataView(trailer.buffer).setBigUint64(8, BigInt(objects.length));
  new DataView(trailer.buffer).setBigUint64(16, BigInt(root));
  new DataView(trailer.buffer).setBigUint64(24, BigInt(tableAt));
  return concat([header, ...enc, table, trailer]);
}
