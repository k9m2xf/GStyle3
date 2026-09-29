// Photo -> twelve real masks, entirely in the browser.
//
// Loads MediaPipe Tasks Vision (JS + WASM) and two models from their public
// hosts on first use, runs face landmarks + person segmentation, derives the
// part regions (landmarks.js) and encodes them with WebCodecs (hevcenc.js).
// No backend: everything stays on this device, matching the project promise.

import { deriveMasks, PART_MATTES, URN_PREFIX } from "./landmarks.js";
import { encodeMask, supportsHevcEncode } from "./hevcenc.js";

const JS_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const Wasm_PATH = `${JS_BASE}/wasm`;
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SEG_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite";

const W = 768, H = 576;
const WORK_EDGE = 1536;
const PERSON_CLASS = 15; // Pascal VOC "person" in deeplab_v3

let visionApi = null;      // cached module
let faceLandmarker = null;
let imageSegmenter = null;

/** Probe what this browser can do, without loading anything heavy. */
export async function capabilities() {
  return { hevc: await supportsHevcEncode() };
}

async function vision() {
  if (visionApi) return visionApi;
  visionApi = await import(`${JS_BASE}/vision_bundle.mjs`);
  const fileset = await visionApi.FilesetResolver.forVisionTasks(Wasm_PATH);
  [faceLandmarker, imageSegmenter] = await Promise.all([
    visionApi.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
      runningMode: "IMAGE", numFaces: 1, refineLandmarks: true,
    }),
    visionApi.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEG_MODEL },
      runningMode: "IMAGE", outputCategoryMask: true,
    }),
  ]);
  return visionApi;
}

/** Work-sized RGBA + the segmentation inputs that share it. */
async function toWorkFrame(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, WORK_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas;
}

function maskFromSegmenter(result, w, h) {
  const cm = result.categoryMask;
  const data = cm ? (cm.getAsUint8Array ? cm.getAsUint8Array() : cm.data) : null;
  if (!data) return null;
  // category mask values are class indices (or shifted by a colour LUT in
  // some builds); only class PERSON matters — accept any byte equal to it.
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) if (data[i] === PERSON_CLASS) out[i] = 255;
  if (cm.close) cm.close();
  return out;
}

function downscaleToMask(workCanvas, mask, w, h) {
  const src = new ImageData(new Uint8ClampedArray(mask.length * 4), w, h);
  for (let i = 0; i < mask.length; i++) src.data[i * 4 + 3] = mask[i];
  const small = new OffscreenCanvas(W, H);
  const ctx = small.getContext("2d");
  // scaling alpha with smoothing approximates the CLI's LANCZOS + threshold
  const tmp = new OffscreenCanvas(w, h);
  tmp.getContext("2d").putImageData(src, 0, 0);
  ctx.drawImage(tmp, 0, 0, W, H);
  const grown = ctx.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = grown[i * 4 + 3] > 127 ? 255 : 0;
  return out;
}

/**
 * Analyze one photo into an upgrade()-ready mask pack.
 * Returns { masks, notes, skipped? } — masks null when the browser cannot
 * encode HEVC (callers fall back to the transplant / pack path).
 */
export async function analyzePhoto(file, onProgress = () => {}) {
  const caps = await capabilities();
  if (!caps.hevc)
    return { masks: null, notes: ["本浏览器不支持在线 HEVC 编码，跳过自动分析"] };

  onProgress("加载分割模型…（首次需联网）");
  await vision();

  onProgress("分割照片…");
  const work = await toWorkFrame(file);
  const w = work.width, h = work.height;
  const rgb = work.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, w, h).data;

  const segResult = imageSegmenter.segment(work);
  const person = maskFromSegmenter(segResult, w, h);

  onProgress("识别人脸关键点…");
  const det = faceLandmarker.detect(work);
  const landmarks = det.faceLandmarks && det.faceLandmarks.length
    ? det.faceLandmarks[0] : null;

  onProgress("推导 12 张区域掩码…");
  const raw = deriveMasks(w, h, landmarks, person, rgb);
  const scaled = {};
  for (const name of PART_MATTES)
    scaled[URN_PREFIX + name] = downscaleToMask(work, raw[name], w, h);

  onProgress("编码 HEVC…");
  const masks = {};
  let n = 0;
  for (const urn of PART_MATTES) {
    const m = scaled[urn];
    let covered = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) covered++;
    onProgress(`编码掩码 ${++n}/12…`);
    const { hvcC, payload } = await encodeMask(m);
    masks[urn] = { hvcC: toHex(hvcC), payload: toHex(payload), covered_px: covered };
  }

  const notes = [
    landmarks ? "人脸关键点已识别（浏览器内分割）" : "未识别人脸，脸部槽位为空",
    person && person.some((v) => v) ? "人像分割已识别" : "人像分割未识别到人物",
    "12 张掩码已在本机生成并编码（照片未离开设备）",
  ];
  return { masks, notes };
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
