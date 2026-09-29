// Region derivation: face landmarks + a person mask -> twelve part masks.
// Pure functions over Uint8Array bitmaps so they run in the browser and in
// Node tests alike. Same landmark groups and rules as tools/make_masks.py.

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361,
  288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132,
  93, 234, 127, 162, 21, 54, 103, 67, 109];
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375,
  321, 405, 314, 17, 84, 181, 91, 146];
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324,
  318, 402, 317, 14, 87, 178, 88, 95];
export const BROW_L = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70];
export const BROW_R = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
export const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158,
  159, 160, 161, 246];
export const EYE_R = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373,
  374, 380, 381, 382];
export const NOSE = [168, 6, 197, 195, 5, 4, 45, 275, 1, 2, 98, 327];

export const URN_PREFIX = "tag:apple.com,2026:photo:aux:";
export const PART_MATTES = [
  "semanticnosematte", "semanticskinmattev2", "semanticnonfaceskinmatte",
  "semanticlipsmatte", "semanticteethmattev2", "semanticpersonmatte",
  "semanticglassesmattev2", "semanticeyebrowsmatte", "semantictattoomatte",
  "semantichandsmatte", "semanticearsmatte", "semanticfaceskinmatte",
];

/** Even-odd scanline fill of one polygon into a w*h Uint8Array mask. */
export function fillPolygon(mask, w, h, pts) {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(h - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc))
        xs.push(x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.round(xs[i]));
      const b = Math.min(w, Math.round(xs[i + 1]));
      mask.fill(255, y * w + a, y * w + b);
    }
  }
}

export function union(dst, src) {
  for (let i = 0; i < dst.length; i++) if (src[i]) dst[i] = 255;
}
export function andNot(dst, src) {
  for (let i = 0; i < dst.length; i++) if (src[i]) dst[i] = 0;
}
export function intersect(dst, src) {
  for (let i = 0; i < dst.length; i++) if (!src[i]) dst[i] = 0;
}

/** Classic YCbCr skin rule over RGB bytes (same coefficients as the CLI). */
export function skinColourMask(rgb, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (cb >= 77 && cb <= 130 && cr >= 133 && cr <= 177) out[i] = 255;
  }
  return out;
}

/**
 * Derive the twelve masks from segmentation outputs.
 *
 * landmarks — normalized face landmarks (478-point refine mode) or null;
 * person — Uint8Array(w*h) 0/255 person silhouette;
 * rgb — RGB bytes of the same frame (for the skin-colour rule).
 * Returns { [urnSuffix]: Uint8Array(w*h) }.
 */
export function deriveMasks(w, h, landmarks, person, rgb) {
  const zero = () => new Uint8Array(w * h);
  const out = {};
  const px = (ids) => ids.map((i) => [
    Math.round(landmarks[i].x * w), Math.round(landmarks[i].y * h),
  ]);
  const hull = (ids, target) => fillPolygon(target, w, h, px(ids));

  const faceOk = !!landmarks;
  const skin = zero();
  if (person && rgb) {
    const colour = skinColourMask(rgb, w * h);
    for (let i = 0; i < skin.length; i++)
      if (person[i] && colour[i]) skin[i] = 255;
  }

  const personMask = person || zero();
  out.semanticpersonmatte = personMask;

  let oval = zero();
  if (faceOk) {
    const lips = zero(), mouth = zero(), brows = zero(), eyes = zero();
    const nose = zero(), ears = zero();
    hull(FACE_OVAL, oval);
    hull(LIPS_OUTER, lips);
    hull(LIPS_INNER, mouth);
    hull(BROW_L, brows); union(brows, (() => { const m = zero(); hull(BROW_R, m); return m; })());
    hull(EYE_L, eyes); union(eyes, (() => { const m = zero(); hull(EYE_R, m); return m; })());
    hull(NOSE, nose);

    // glasses = eye bands + a soft bridge (filled hull of eye-centre columns)
    const glasses = zero();
    union(glasses, eyes);
    hull([168, 6], glasses); // bridge polygon (degenerates gracefully)

    // ears: strips at the face-oval extremes (no ear detector)
    let minX = w, maxX = 0, minY = h, maxY = 0;
    for (const [x, y] of px(FACE_OVAL)) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const span = Math.max(maxX - minX, maxY - minY);
    const earW = Math.max(Math.floor(span / 6), 8);
    const earTop = minY + Math.floor((maxY - minY) / 3);
    const earBot = minY + Math.floor((maxY - minY) * 3 / 4);
    for (let y = earTop; y < earBot; y++) {
      for (let x = Math.max(0, minX - earW); x < minX; x++) ears[y * w + x] = 255;
      for (let x = maxX; x < Math.min(w, maxX + earW); x++) ears[y * w + x] = 255;
    }

    out.semanticnosematte = nose;
    out.semanticlipsmatte = lips;
    out.semanticteethmattev2 = mouth;
    out.semanticeyebrowsmatte = brows;
    out.semanticglassesmattev2 = glasses;
    out.semanticearsmatte = (() => { intersect(ears, personMask); return ears; })();

    const uncovered = zero();
    union(uncovered, eyes); union(uncovered, brows);
    union(uncovered, lips); union(uncovered, nose);
    const faceSkin = zero();
    union(faceSkin, oval); intersect(faceSkin, skin); andNot(faceSkin, uncovered);
    out.semanticfaceskinmatte = faceSkin;

    const nonFace = zero();
    union(nonFace, skin); andNot(nonFace, oval);
    out.semanticnonfaceskinmatte = nonFace;
  } else {
    for (const k of ["semanticnosematte", "semanticlipsmatte",
      "semanticteethmattev2", "semanticeyebrowsmatte", "semanticglassesmattev2",
      "semanticearsmatte", "semanticfaceskinmatte"]) out[k] = zero();
    out.semanticnonfaceskinmatte = skin;
  }

  out.semanticskinmattev2 = skin;
  // Browser v1: no hand detector — honestly empty (the CLI can do hands).
  out.semantichandsmatte = zero();
  out.semantictattoomatte = zero();
  for (const name of PART_MATTES) if (!out[name]) out[name] = zero();
  return out;
}
