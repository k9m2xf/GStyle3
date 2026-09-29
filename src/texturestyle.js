// MakerNote 里的摄影风格3 质感记录（tag 84 / 0x54）。
//
// 这份记录是一个嵌在 Apple MakerNote 二进制里的 binary plist，条目之间没有可
// 靠的 TLV 边界——实测各条目前导字节是 `52 00` / `0a 00` / `5f 00` / `00 2e`
// 这种无规律的值，所以按**内容签名**定位，不按偏移：顶层是 dict、字符串键里含
// "8" "9" "10" "11" "12"，分别对应 preset / intensity / grain /
// originalInsteadOfReversibility / renderingVersion。键 "0".."7" 是 info 字段。
//
// 已知 preset 映射：1=Standard 2=Soft(柔肤) 3=Studio 4=Filmic(胶片) 5=Glowy。
//
// **改写全程等长。** bplist 共享取值相同的对象（实测 "8"↔"4"、"9"↔"3"、
// "12"↔"0" 各共用一个对象），而直接覆写会连带改掉 info 字段——那些是
// NeutrinoCore 会校验的必填项。解法：先在**字节完全相同**的另一个对象上安置
// sharer，腾出原槽位再写新值。供体里 int 1 有三个独立副本（"4"/"8"、"5"、
// "12"/"0"），所以 preset 能这样改；没有副本可借的字段（实测是 intensity，
// 它的 real 对象全被占用）只能报需要重建 plist——那会改变长度，进而要重建
// MakerNote 与 EXIF IFD 链，本模块不做。

/** 记录里必须存在的键，兼作内容签名。 */
import { readGraph } from "./items.js";

const SIGNATURE = ["8", "9", "10", "11", "12"];

const FIELD_KEY = {
  preset: "8",
  intensity: "9",
  grain: "10",
  originalInsteadOfReversibility: "11",
  renderingVersion: "12",
};

const be = (b, p, n) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[p + i];
  return v;
};

const ascii = (b, p, len) => {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[p + i]);
  return s;
};

/**
 * 在一段二进制里定位并解析 tag 84 记录。
 * 返回 { start, end, keys, values, markers, refOffset }
 *   values[k]  = { t, v, from, to }  取值对象在 plist 内的字节区间
 *   markers[k] = { pos, size }       该键的取值引用 marker 所在处（供改指）
 */
export function findTextureStyleRecord(buf) {
  for (let o = 0; o + 8 <= buf.length; o++) {
    if (buf[o] !== 0x62 || buf[o + 1] !== 0x70 || buf[o + 2] !== 0x6c
      || buf[o + 3] !== 0x69 || buf[o + 4] !== 0x73 || buf[o + 5] !== 0x74
      || buf[o + 6] !== 0x30 || buf[o + 7] !== 0x30) continue;
    const rec = tryParse(buf, o);
    if (rec) return rec;
  }
  return null;
}

/** 给定 bplist00 起点，按 trailer 推算长度并解析；签名不符返回 null。 */
function tryParse(buf, o) {
  for (let e = o + 33; e <= buf.length; e++) {
    const t = e - 32;
    const offSize = buf[t + 6];
    if (offSize !== 1 && offSize !== 2 && offSize !== 4 && offSize !== 8) continue;
    const nObj = be(buf, t + 8, 8);
    const offTable = be(buf, t + 24, 8);
    if (nObj === 0 || nObj > 4096) continue;
    if (offTable + nObj * offSize + 32 !== e - o) continue;
    // trailer 已唯一确定本 plist 的结尾
    const parsed = parseDict(buf, o, e);
    if (!parsed) return null;
    if (!SIGNATURE.every((k) => parsed.keys.includes(k))) return null;
    return { start: o, end: e, ...parsed };
  }
  return null;
}

function parseDict(buf, start, end) {
  // start/end 都是绝对下标；trailer 是 plist 的最后 32 字节
  const trailer = end - 32;
  const offSize = buf[trailer + 6];
  const top = be(buf, trailer + 16, 8);
  const offTable = be(buf, trailer + 24, 8);
  const nObj = be(buf, trailer + 8, 8);
  // offset table 里的值是相对 plist 起点的字节偏移
  const at = (i) => be(buf, start + offTable + i * offSize, offSize);
  // 偏移 -> 引用它的 marker 应当填的索引
  const indexOfOffset = new Map();
  for (let i = 0; i < nObj; i++) if (!indexOfOffset.has(at(i))) indexOfOffset.set(at(i), i);

  const dp = start + at(top);
  if (dp >= end || buf[dp] >> 4 !== 0xd) return null; // 必须顶层是 dict
  const count = buf[dp] & 0x0f;
  // 键/值是**对象索引**，以 marker 形式存在 dict 头之后。索引 0..15 是单字节
  // 0x00..0x0F（0x0F 本身是合法索引，不是「转两字节」的信号）；两字节形式只在
  // marker >= 0xF0 时才出现。
  const marker = (p) => (buf[p] < 0xf0 ? buf[p] : ((buf[p] & 0x0f) << 8) | buf[p + 1]);
  const markerSize = (p) => (buf[p] < 0xf0 ? 1 : 2);

  // 只解析标量；遇到集合 / data 判为不匹配（本记录不该有）
  const scalar = (idx) => {
    const p = start + at(idx);
    if (p >= end) return null;
    // 0x08 / 0x09 是**完整的一字节对象**（false / true），不是「类型 + 值字节」
    if (buf[p] === 0x08) return { t: "bool", v: false, from: p, to: p + 1 };
    if (buf[p] === 0x09) return { t: "bool", v: true, from: p, to: p + 1 };
    const ty = buf[p] >> 4, info = buf[p] & 0x0f;
    // int / real 的低半字节是**指数**，字节数 = 1 << nibble；data / string /
    // 集合 的低半字节才是长度。0xF 表示字节数另存 4 字节。
    const pow2 = ty === 0x1 || ty === 0x2;
    const len = info === 0x0f ? be(buf, p + 1, 4) : (pow2 ? 1 << info : info);
    const s = p + (info === 0x0f ? 5 : 1);
    switch (ty) {
      case 0x0: return { t: "null", v: null, from: p, to: s };
      case 0x1: return { t: "int", v: be(buf, s, len), from: p, to: s + len };
      case 0x2: return {
        t: "real",
        // bplist 的 real 是大端 IEEE754。用无后缀 + 显式 false 读，既不依赖
        // getFloat32BE 这种在部分运行时缺席的名字，也把字节序写明。
        v: len === 4
          ? new DataView(buf.buffer, buf.byteOffset + s, 4).getFloat32(0, false)
          : new DataView(buf.buffer, buf.byteOffset + s, 8).getFloat64(0, false),
        from: p, to: s + len,
      };
      case 0x5: case 0x6:
        return { t: "str", v: ascii(buf, s, len), from: p, to: s + len };
      default: return null;
    }
  };

  const keys = [], values = {}, markers = {};
  for (let i = 0; i < count; i++) {
    const kPos = dp + 1 + i, vPos = dp + 1 + count + i;
    const k = scalar(marker(kPos)), v = scalar(marker(vPos));
    if (!k || !v || k.t !== "str") return null;
    keys.push(k.v);
    values[k.v] = v;
    markers[k.v] = { pos: vPos, size: markerSize(vPos) };
  }
  return { keys, values, markers, indexOfOffset };
}

/** 把记录读成便于查看的对象。 */
export function readTextureStyle(rec) {
  const out = { info: {} };
  for (let i = 0; i <= 7; i++) {
    const k = String(i);
    if (rec.values[k]) out.info[k] = rec.values[k].v;
  }
  out.preset = rec.values["8"].v;
  out.intensity = rec.values["9"].v;
  out.grain = rec.values["10"].v;
  out.originalInsteadOfReversibility = rec.values["11"].v;
  out.renderingVersion = rec.values["12"].v;
  return out;
}

/** 与 key 共用同一个取值对象的其他键。 */
export function sharedWith(rec, key) {
  const t = rec.values[key];
  return rec.keys.filter((k) => k !== key
    && rec.values[k].from === t.from && rec.values[k].to === t.to);
}

/** plist 内某段字节的十六进制签名（只在本模块内比较用）。 */
const sigOf = (buf, from, to) => {
  let s = "";
  for (let i = from; i < to; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
};

/**
 * key 的取值若被共享，能否靠"改指到字节相同的另一个对象"腾出槽位。
 * 供体里 int 1 有三个独立副本，所以 preset 可以；real 槽位全被占满，intensity 不能。
 */
export function canUnshare(src, rec, key) {
  const t = rec.values[key];
  const want = sigOf(src, t.from, t.to);
  return rec.keys.some((other) => other !== key
    && rec.values[other].from !== t.from
    && sigOf(src, rec.values[other].from, rec.values[other].to) === want);
}

/** 改写一个标量对象。`val` 的字节区间必须放得下新值。 */
function writeScalar(out, val, value) {
  const { from, t } = val;
  const n = val.to - from - 1; // 值字节数（跳过类型标记）
  switch (t) {
    case "int": {
      if (!Number.isInteger(value) || value < 0) throw new Error("int 值非法");
      if (value >= Math.pow(2, 8 * n)) throw new Error(`int ${value} 放不进 ${n} 字节`);
      let v = BigInt(value);
      for (let i = 0; i < n; i++) { out[val.to - 1 - i] = Number(v & 0xffn); v >>= 8n; }
      return out;
    }
    case "real": {
      if (n !== 4) throw new Error("只支持 4 字节 real");
      new DataView(out.buffer, out.byteOffset + from + 1, 4).setFloat32(0, value, false);
      return out;
    }
    case "bool": {
      out[from] = value ? 0x09 : 0x08; // bplist 的 bool 就是这两个单字节标记
      return out;
    }
    default: throw new Error(`不能改写类型 ${t}`);
  }
}

/** 把某个键的取值引用改指到另一个对象索引。 */
function repoint(buf, rec, key, objIndex) {
  const m = rec.markers[key];
  if (m.size === 1) {
    if (objIndex > 0xef) throw new Error("目标索引超过单字节 marker 范围");
    buf[m.pos] = objIndex;
  } else {
    buf[m.pos] = 0xf0 | (objIndex >> 8 & 0x0f);
    buf[m.pos + 1] = objIndex & 0xff;
  }
}

/**
 * 改写 tag 84 记录。`patch` 是 { preset?, intensity?, grain?,
 * originalInsteadOfReversibility?, renderingVersion? }。
 * 返回新的 Exif 负载，长度与输入完全相同。
 *
 * 共享处理：目标取值若与其他键共用，先把那些键改指到一个**字节完全相同**的
 * 对象上（供体里 int 1 有三个副本，所以 preset 可解），再覆写原槽位。找不到
 * 可借的副本就报错——那种情况必须重建 plist，长度随之改变，本模块不做。
 */
export function patchTextureStyle(exifPayload, patch) {
  const rec = findTextureStyleRecord(exifPayload);
  if (!rec) throw new Error("没找到 tag 84 质感记录");
  const src = Uint8Array.from(exifPayload);
  const out = Uint8Array.from(exifPayload);
  const notes = [];

  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const key = FIELD_KEY[name];
    if (!key) throw new Error(`未知字段 ${name}`);
    const target = rec.values[key];
    const sharers = sharedWith(rec, key);

    if (sharers.length) {
      // 找一个字节完全相同、且不是目标本身的对象，把 sharer 挪过去
      const want = sigOf(src, target.from, target.to);
      let donor = null;
      for (const other of rec.keys) {
        if (other === key) continue;
        const v = rec.values[other];
        if (v.from === target.from) continue;                 // 同一对象
        if (sigOf(src, v.from, v.to) !== want) continue;      // 内容必须一致
        donor = v;
        break;
      }
      if (!donor)
        throw new Error(`${name}(键 "${key}") 的取值对象与 ${sharers.join("、")} 共享，`
          + "且没有字节相同的对象可供改指；需要重建 plist（会改变长度，"
          + "进而要重建 MakerNote 与 EXIF IFD 链）");
      const idx = rec.indexOfOffset.get(donor.from - rec.start);
      if (idx === undefined) throw new Error("找不到替代对象的引用索引");
      for (const s of sharers) repoint(out, rec, s, idx);
      notes.push(`${name}: ${sharers.join("、")} 改指到字节相同的对象，腾出槽位`);
    }

    writeScalar(out, target, value);
    notes.push(`${name} = ${value}`);
  }

  if (out.length !== exifPayload.length) throw new Error("等长改写失败：长度变了");
  return { exif: out, notes };
}

/**
 * 对整张照片改写 tag 84 记录，返回新的 HEIC 字节。
 *
 * 因为 patchTextureStyle 是**等长**的，容器的 iloc / iinf / mdat 全部不需要动：
 * Exif 条目的 offset 与 length 依然有效，只把那几个字节原位替换掉即可。
 * （如果将来要支持会变长的改动，这里就得重建容器，参见 items.js 的 attach。）
 */
export function patchPhoto(heicBytes, patch) {
  const g = readGraph(heicBytes);
  const exifId = [...g.items.values()].find((it) => it.type === "Exif")?.id;
  if (exifId === undefined) throw new Error("照片没有 Exif 条目");
  const loc = g.locs.get(exifId);
  if (!loc || loc.extents.length !== 1)
    throw new Error("Exif 条目不是单段存储，无法原位改写");
  if (loc.method !== 0) throw new Error("Exif 条目存在 idat 里，无法原位改写");
  const off = loc.extents[0].off, len = loc.extents[0].len;
  const before = g.d.slice(off, off + len);
  const { exif, notes } = patchTextureStyle(before, patch);
  if (exif.length !== len) throw new Error("Exif 长度变了，容器需要重建");

  const out = Uint8Array.from(g.d);
  out.set(exif, off);
  return { bytes: out, notes };
}
