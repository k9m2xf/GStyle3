// Photographic Styles 2 → 3 upgrade: the container contract that makes Photos
// offer the texture / film grain / glow editors, attached onto a photo that
// keeps its own Styles 2 data.
//
// The contract, verified against iPhone 18 Pro captures:
//   · a `uri ` metadata item named `metadata`, content type
//     tag:apple.com,2026:photo:metadata:texture_styles, described by cdsc of the
//     primary image and its tmap, payload a small textureInfo bplist;
//   · twelve 2026 semantic part mattes (768x576 8-bit HEVC masks natively),
//     each with its own auxC URN and auxl -> [primary, tmap].
//
// Soft-skin is the one effect that works through the part mattes — everything
// else is global. Native mattes are real segmentation masks; a placeholder is
// empty, so soft-skin has no region to act on. This build can therefore
// transplant the photo's OWN old-generation skin matte
// (urn:com:apple:photo:2019:aux:semanticskinmatte — a real mask on most 16/17
// portraits) into the new skin slots and see whether that is enough.

import { build } from "./bplist.js";
import { readGraph, payloadOf, propOf, auxUriOf, attach, Unsupported } from "./items.js";

export { Unsupported };

export const STYLES_URI = "tag:apple.com,2023:photo:metadata:styles";
export const TEXTURE_URI = "tag:apple.com,2026:photo:metadata:texture_styles";
export const OLD_SKIN_URI = "urn:com:apple:photo:2019:aux:semanticskinmatte";

// Every aux image is INTERPRETED through its XMP sidecar (a 'mime' item whose
// cdsc describes the matte); without it Photos does not decode the mask at all.
// Native captures pair each 2026 matte with this constant 357-byte FSINC
// declaration — byte-identical across all twelve, copied verbatim from the
// iPhone 18 Pro donor.
export const SIDECAR_XML = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 6.0.0">
   <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description rdf:about=""
            xmlns:fsincMattes="http://ns.apple.com/fsinc/1.0/">
         <fsincMattes:FSINCMatteVersion>0</fsincMattes:FSINCMatteVersion>
      </rdf:Description>
   </rdf:RDF>
</x:xmpmeta>
`;
export const SIDECAR_XML_BYTES =
  Uint8Array.from(SIDECAR_XML, (c) => c.charCodeAt(0));

const A = "tag:apple.com,2026:photo:aux:";
/** The twelve slots, in the order native captures write them. `skin` marks the
 *  ones soft-skin plausibly reads; the transplanted mask goes there (plus the
 *  person slot, which scopes person-wide effects). */
export const PART_MATTES = [
  { urn: A + "semanticnosematte" },
  { urn: A + "semanticskinmattev2", skin: true },
  { urn: A + "semanticnonfaceskinmatte", skin: true },
  { urn: A + "semanticlipsmatte" },
  { urn: A + "semanticteethmattev2" },
  { urn: A + "semanticpersonmatte", skin: true },
  { urn: A + "semanticglassesmattev2" },
  { urn: A + "semanticeyebrowsmatte" },
  { urn: A + "semantictattoomatte" },
  { urn: A + "semantichandsmatte" },
  { urn: A + "semanticearsmatte" },
  { urn: A + "semanticfaceskinmatte", skin: true },
];

const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

// One near-empty 768x576 mask and its properties, copied verbatim from a real
// capture's semanticteethmattev2 (156 bytes of almost nothing). Reused for
// every slot without real content.
export const PLACEHOLDER = {
  sample: hex(
    "000000982801af125d4a2e6b16b8568b3aff69673923276053f5fc0000030000030000030000"
    + "03011b0a0c580000030000030000030000030000069c00000300000300000300000300000300"
    + "3ca0000003000003000003000003000352000003000003000003000003032a00000300000300"
    + "0003000074c00000030000030000030003fc000003000003000003000ea80000030000030000"
    + "03002820"),
  ispe: hex("0000001469737065000000000000030000000240"),
  pixi: hex("0000000e70697869000000000108"),
  hvcC: hex(
    "0000006f68766343010408000000bfc8000000005af000fcfcf8f800000b03a0000100174001"
    + "0c01ffff040800000300bfc800000300005a170240a100010021420101040800000300bfc800"
    + "000300005ac0180802416205e49165537020202008a2000100094401c061d2421014c9"),
};

/** The textureInfo payload: the head every Styles 3 capture carries. */
export function textureInfo(grainSeed = 104) {
  return build([
    ["Preset", "Standard"],
    ["CaptureType", "LF"],
    ["CaptureMode", "Still"],
    ["PortType", "PortTypeBack"],
    ["HardwareModel", "iPhone19,2"],
    ["TextureStylePeopleDataVersion", 3],
    ["FilmGrainSeed", grainSeed],
  ]);
}

/**
 * Upgrade one photo. Returns { bytes, notes }; throws Unsupported when the
 * photo cannot take the contract.
 *
 * opts.reuseSkinMatte — transplant the photo's own old skin matte into the
 * four skin-scope slots (the soft-skin experiment). Default true.
 * opts.masks — { [urn]: { payload, hvcC, note? } } pre-encoded real masks
 * (from tools/make_masks.py); takes precedence over transplant/placeholder and
 * removes the need for reuseSkinMatte.
 */
export function upgrade(file, opts = {}) {
  const reuseSkin = opts.reuseSkinMatte !== false;
  const custom = opts.masks || null;
  const g = readGraph(file);
  const notes = [];

  // The upgrade is defined for photos that own Styles 2 data.
  const stylesId = [...g.items.values()]
    .find((it) => it.type === "uri " && it.uri === STYLES_URI)?.id;
  if (stylesId === undefined)
    throw new Unsupported("照片不带摄影风格 2 数据，无法升级");
  notes.push("保留照片自带的摄影风格 2 数据");

  const present = new Set();
  for (const id of g.items.keys()) {
    const urn = auxUriOf(g, id);
    if (urn) present.add(urn);
    const it = g.items.get(id);
    if (it.type === "uri " && it.uri === TEXTURE_URI) present.add(TEXTURE_URI);
  }

  // The soft-skin experiment source: the photo's own real skin mask.
  let skin = null;
  if (reuseSkin) {
    const id = [...g.items.keys()].find((i) => auxUriOf(g, i) === OLD_SKIN_URI);
    if (id !== undefined) {
      const props = ["ispe", "pixi", "hvcC"].map((t) => propOf(g, id, t));
      if (props.every(Boolean)) {
        skin = { payload: payloadOf(g, id), props };
        notes.push("找到旧代皮肤掩码，复用到 4 个皮肤槽位（柔肤实验）");
      } else {
        notes.push("旧代皮肤掩码缺少属性，跳过复用");
      }
    } else {
      notes.push("照片没有旧代皮肤掩码，皮肤槽位用空占位（柔肤将无效果）");
    }
  } else {
    notes.push("已关闭旧代皮肤掩码复用");
  }

  const tmaps = [...g.items.values()].filter((it) => it.type === "tmap").map((it) => it.id);
  const targets = [g.primary, ...tmaps.slice(0, 1)];

  // 768x576 mono geometry shared by every mask slot (a full ispe property box).
  const maskIspe = () => {
    const b = new Uint8Array(20);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 20);
    b.set([0x69, 0x73, 0x70, 0x65], 4); // 'ispe'
    // bytes 8..11: FullBox version/flags = 0
    dv.setUint32(12, 768);
    dv.setUint32(16, 576);
    return b;
  };
  // Accept both a full hvcC property box and a bare configuration payload.
  const asBox = (v) => {
    const bytes = toBytes(v);
    if (bytes.length > 8
      && String.fromCharCode(...bytes.subarray(4, 8)) === "hvcC") return bytes;
    const b = new Uint8Array(8 + bytes.length);
    new DataView(b.buffer).setUint32(0, 8 + bytes.length);
    b.set([0x68, 0x76, 0x63, 0x43], 4); // 'hvcC'
    b.set(bytes, 8);
    return b;
  };
  const maskPixi = (hvcc) => {
    // hvcC's chromaFormat must agree with pixi. Native part mattes are
    // monochrome with channels [(1, 8)]. The CLI encodes gray, so it produces
    // the native shape byte-for-byte. Browser WebCodecs has no monochrome HEVC
    // mode and emits 4:2:0, which has no native counterpart to copy — declare
    // it honestly as Y/Cb/Cr at 8 bits, one (type, depth) pair per plane.
    if (hvcc.length < 27) throw new Unsupported("掩码缺少有效的 hvcC 配置");
    const channels = (hvcc[24] & 3) === 0 ? 1 : 3;
    return channels === 1 ? PLACEHOLDER.pixi
      : hex("000000127069786900000000010802080308");
  };

  const plan = [];
  if (!present.has(TEXTURE_URI)) {
    plan.push({
      key: "texture", itemType: "uri ", itemName: "metadata", itemUri: TEXTURE_URI,
      links: [{ type: "cdsc", tos: targets }],
      payload: textureInfo(),
    });
    notes.push("texture_styles 已注入");
  } else {
    notes.push("texture_styles 已存在");
  }

  // Which mattes are already described by an XMP sidecar (any cdsc target)?
  const described = new Set();
  for (const r of g.refs) if (r.type === "cdsc") for (const t of r.tos) described.add(t);
  const sidecarPlan = (target) => ({
    key: `sc:${target}`, itemType: "mime", contentType: "application/rdf+xml",
    links: [{ type: "cdsc", tos: [target] }], // matte urn (new) or id (existing)
    payload: SIDECAR_XML_BYTES,
  });

  let real = 0, reused = 0, held = 0, sidecars = 0, healed = 0;
  for (const m of PART_MATTES) {
    if (present.has(m.urn)) {
      held++;
      const mid = [...g.items.keys()].find((i) => auxUriOf(g, i) === m.urn);
      if (mid !== undefined && !described.has(mid)) {
        plan.push(sidecarPlan(mid)); sidecars++; healed++;
      }
      continue;
    }
    const own = custom && custom[m.urn];
    const transplanted = !own && m.skin && skin;
    if (own || transplanted) real++;
    if (transplanted) reused++;
    let props, payload;
    if (own) {
      const hvcc = asBox(own.hvcC);
      props = [maskIspe(), maskPixi(hvcc), hvcc];
      payload = toBytes(own.payload);
    } else if (transplanted) {
      props = skin.props;
      payload = skin.payload;
    } else {
      props = [PLACEHOLDER.ispe, PLACEHOLDER.pixi, PLACEHOLDER.hvcC];
      payload = PLACEHOLDER.sample;
    }
    plan.push({
      key: m.urn, itemType: "hvc1", auxUrn: m.urn,
      links: [{ type: "auxl", tos: targets }],
      props,
      propEssential: [false, false, true], // ispe, pixi, hvcC — native shape
      payload,
    });
    plan.push(sidecarPlan(m.urn));
    sidecars++;
  }
  const added = PART_MATTES.length - held;
  if (held === PART_MATTES.length) notes.push("12 个语义 matte 已存在");
  else {
    const bits = [`${added} 项已注入`];
    if (custom) {
      const covered = PART_MATTES.filter((mm) => custom[mm.urn]).length;
      if (covered) bits.push(`${covered} 项真实分割掩码`);
      if (added - covered - reused) bits.push(`${added - covered - reused} 项空占位`);
    } else if (reused) {
      bits.push(`${reused} 项复用真实肤掩码`);
      if (added - reused) bits.push(`${added - reused} 项空占位`);
    } else if (added) {
      bits.push("全部空占位");
    }
    if (held) bits.push(`${held} 项原样保留`);
    notes.push(`语义 matte：${bits.join("，")}`);
  }
  if (sidecars) notes.push(`FSINC sidecar：${sidecars} 项已注入${healed ? `（含为已有 matte 补的 ${healed} 份）` : ""}`);
  else notes.push("FSINC sidecar：12 份齐全");

  return { bytes: plan.length ? attach(g, plan) : file, notes };
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") {
    const out = new Uint8Array(v.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(v.substr(i * 2, 2), 16);
    return out;
  }
  throw new Error("mask payload must be hex or Uint8Array");
}
