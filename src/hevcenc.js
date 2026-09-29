// In-browser HEVC encode for one monochrome-ish mask via WebCodecs, then the
// hvcC/payload split the HEIF contract needs.
//
// WebCodecs HEVC encoding exists on Apple platforms (Safari / iOS / macOS);
// every other browser fails the capability probe and callers fall back to a
// prebuilt mask pack. Two untestable-on-Linux details are handled defensively:
// chunks may arrive annex-B framed or length-prefixed (both parsers below),
// and the hvcC header is rebuilt from the stream's own SPS (profile/level/
// chroma) instead of copied, because WebCodecs encodes 4:2:0, not the native
// monochrome.

const HVCC_FIXED = 22; // version..frame-info, before numOfArrays

/** True when this browser can encode HEVC at all. */
export async function supportsHevcEncode() {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    const res = await VideoEncoder.isConfigSupported({
      codec: "hvc1.4.1.H120.B0", width: 768, height: 576, bitrate: 1_000_000,
      framerate: 1,
    });
    return !!res.supported;
  } catch { return false; }
}

/** Annex-B or length-prefixed bitstream -> [(nalType, bytes)]. */
export function splitNals(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const isAnnexB = b[0] === 0 && b[1] === 0
    && (b[2] === 1 || (b[2] === 0 && b[3] === 1));
  const marks = [];
  if (isAnnexB) {
    let i = 0;
    while (i < b.length - 3) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) {
        marks.push(i + 4); i += 4;
      } else if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
        marks.push(i + 3); i += 3;
      } else i++;
    }
    const nals = [];
    for (let k = 0; k < marks.length; k++) {
      const begin = marks[k];
      const end = k + 1 < marks.length
        ? (b[marks[k + 1] - 1] === 1 ? marks[k + 1] - 4 : marks[k + 1] - 3)
        : b.length;
      let stop = end;
      while (stop > begin && b[stop - 1] === 0) stop--; // byte-stream padding
      nals.push([b[begin] >> 1 & 0x3f, b.subarray(begin, Math.max(begin, stop))]);
    }
    return nals;
  }
  let p = 0;
  const nals = [];
  while (p + 4 <= b.length) {
    const len = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0;
    if (!len || p + 4 + len > b.length) break;
    const body = b.subarray(p + 4, p + 4 + len);
    nals.push([body[0] >> 1 & 0x3f, body]);
    p += 4 + len;
  }
  return nals;
}

/** Minimal SPS reader: profile/tier/level block + chroma_format_idc. */
function readSpsProfile(sps) {
  // sps[0..2): NAL header; sps[2]: vps_id(4) + max_sub_layers(3) + nesting(1)
  const maxSub = (sps[2] >> 1) & 0x07;
  let bit = 2 * 8 + 1 * 8; // byte offset after sps[2]
  let bitPos = bit;
  const readBits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((sps[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
      bitPos++;
    }
    return v;
  };
  if (maxSub > 0) {
    const present = [];
    for (let i = 0; i < maxSub; i++)
      present.push([readBits(1) | (readBits(1) << 1)]); // [profile, level] packed
    for (let i = maxSub; i < 8; i++) readBits(2); // reserved
    for (let i = 0; i < maxSub; i++) {
      if (present[i] & 1) bitPos += 88; // sub-layer profile block
      if (present[i] & 2) bitPos += 8;  // sub-layer level
    }
  }
  const profile = sps[bitPos >> 3]; // space/tier/idc byte, same layout as hvcC
  const compat = sps.subarray((bitPos >> 3) + 1, (bitPos >> 3) + 5);
  const constraints = sps.subarray((bitPos >> 3) + 5, (bitPos >> 3) + 11);
  const level = sps[(bitPos >> 3) + 11];
  bitPos = ((bitPos >> 3) + 12) * 8; // after general PTL
  const ue = () => { // exp-Golomb
    let z = 0;
    while (readBits(1) === 0) z++;
    return (1 << z) - 1 + (z ? readBits(z) : 0);
  };
  ue(); // sps_seq_parameter_set_id
  const chroma = ue(); // chroma_format_idc
  return { profile, compat, constraints, level, chroma };
}

/** The twelve mask slots all share one hvcC/payload pair. */
export function buildMaskConfig(nals) {
  const params = nals.filter(([t]) => t === 32 || t === 33 || t === 34);
  const vcl = nals.filter(([t]) => t >= 16 && t <= 21);
  const sps = params.find(([t]) => t === 33);
  if (!sps || !vcl.length)
    throw new Error(`HEVC stream lacks SPS or slice (types: ${nals.map(([t]) => t)})`);
  const prof = readSpsProfile(sps[1]);

  const header = new Uint8Array(HVCC_FIXED);
  header[0] = 1; // configurationVersion
  header[1] = prof.profile;
  header.set(prof.compat, 2);
  header.set(prof.constraints, 6);
  // Native captures declare level 3.0 for these 768x576 masks. WebCodecs
  // reports whatever level_idc its SPS carries, which for a single tiny frame
  // is often 0 — a value strict readers treat as undefined. Pin the native
  // value; 768x576 can never exceed it.
  header[12] = 0x5a;
  header[13] = 0xf0; header[14] = 0x00; // min_spatial_segmentation = 0
  header[15] = 0xfc;                     // parallelismType = 0
  header[16] = 0xfc | (prof.chroma & 3); // chromaFormat from the stream's SPS
  header[17] = 0xf8;                     // bitDepthLumaMinus8 = 0
  header[18] = 0xf8;                     // bitDepthChromaMinus8 = 0
  header[19] = 0x00; header[20] = 0x00;  // avgFrameRate
  // Frame info as native captures write it: one temporal layer, and
  // lengthSizeMinusOne = 3 because buildMaskConfig() writes four-byte NAL
  // lengths below. Declaring 2 here desynchronises every reader from the
  // payload and the mask silently fails to decode.
  header[21] = 0x0b;

  const body = [header, Uint8Array.of(params.length)];
  for (const [t, bytes] of params) {
    const head = new Uint8Array(5);
    head[0] = 0x80 | t;
    head[2] = 1; // numNalus — a zero here declares an empty parameter set array
    head[3] = bytes.length >> 8; head[4] = bytes.length & 0xff;
    body.push(head, bytes);
  }
  const boxBytes = concatBytes(body);
  const hvcc = new Uint8Array(8 + boxBytes.length);
  new DataView(hvcc.buffer).setUint32(0, 8 + boxBytes.length);
  hvcc.set([0x68, 0x76, 0x63, 0x43], 4);
  hvcc.set(boxBytes, 8);

  let total = 0;
  for (const [, bytes] of vcl) total += 4 + bytes.length;
  const payload = new Uint8Array(total);
  let o = 0;
  for (const [, bytes] of vcl) {
    payload[o] = bytes.length >>> 24; payload[o + 1] = bytes.length >>> 16;
    payload[o + 2] = bytes.length >>> 8; payload[o + 3] = bytes.length;
    payload.set(bytes, o + 4);
    o += 4 + bytes.length;
  }
  return { hvcC: hvcc, payload };
}

function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Encode one 768x576 mask (Uint8Array, values 0/255) -> { hvcC, payload }.
 * Rejects when the browser cannot encode HEVC.
 */
export async function encodeMask(mask) {
  const w = 768, h = 576;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);

  const chunks = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      chunks.push(b);
    },
    error: (e) => { throw e; },
  });
  encoder.configure({
    codec: "hvc1.4.1.H120.B0", width: w, height: h,
    bitrate: 1_500_000, framerate: 1,
  });
  encoder.encode(new VideoFrame(canvas, { timestamp: 0, duration: 1_000_000 }));
  await encoder.flush();
  encoder.close();

  // Concatenated chunk framing is unknown (annex-B vs length-prefix); let
  // splitNals sniff it. If both shapes appear mixed per-chunk, split per chunk.
  let joined = concatBytes(chunks);
  let nals = splitNals(joined);
  if (!nals.length) {
    nals = chunks.flatMap((c) => splitNals(c));
  }
  if (!nals.length) throw new Error("HEVC 编码没有产出可解析的 NAL");
  return buildMaskConfig(nals);
}
