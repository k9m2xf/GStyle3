#!/usr/bin/env python3
"""Real semantic part masks for the Styles 3 contract — the step XDRemux left
as pure-black placeholders.

Pipeline: decode HEIC -> MediaPipe segmentation (person / face landmarks /
hands) -> derive the twelve 768x576 part masks -> encode each as a monochrome
HEVC item payload + hvcC config -> emit a mask pack JSON the injector consumes.

  .venv/bin/python tools/make_masks.py PHOTO.HEIC OUT_DIR

OUT_DIR gets mask-pack.json (hex payloads, portable) and preview.png (4x3
montage of the twelve masks) so the result is eyeballable before injection.

Honest approximations, documented per slot:
  person/skin/nonfaceskin/face skin/nose/lips/eyebrows/eyes-bands/hands —
  derived from real segmentation;
  teeth  = mouth interior (inside the inner lip line);
  ears   = strips at the face-oval edges (no ear detector);
  tattoo = always empty (no detector — a placeholder, not a fake).
"""

import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import pillow_heif
import mediapipe as mp
import av

pillow_heif.register_heif_opener()

W, H = 768, 576
WORK_EDGE = 1536

# The hvcC fixed header (22 bytes) copied from a native capture's mask config:
# monochrome chroma format, 8-bit, same geometry — Apple's own values. The last
# byte is the frame-info octet: 0x0b is what native captures carry and it sets
# lengthSizeMinusOne = 3, matching the four-byte NAL lengths written below.
# (0x0a declares three-byte lengths and desynchronises every reader from the
# payload, which is how the first round of masks failed to decode at all.)
# The byte after it (numOfArrays) is written per mask below.
REFERENCE_HVCC = bytes.fromhex(
    "010408000000bfc8000000005af000fcfcf8f800000b")

# FaceMesh landmark groups (478-point refine mode).
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397,
             365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58,
             132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405,
              314, 17, 84, 181, 91, 146]
LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402,
              317, 14, 87, 178, 88, 95]
BROW_L = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70]
BROW_R = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336]
EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160,
         161, 246]
EYE_R = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374,
         380, 381, 382]
NOSE = [168, 6, 197, 195, 5, 4, 45, 275, 1, 2, 98, 327]

MATTES = [
    "semanticnosematte", "semanticskinmattev2", "semanticnonfaceskinmatte",
    "semanticlipsmatte", "semanticteethmattev2", "semanticpersonmatte",
    "semanticglassesmattev2", "semanticeyebrowsmatte", "semantictattoomatte",
    "semantichandsmatte", "semanticearsmatte", "semanticfaceskinmatte",
]
URN_PREFIX = "tag:apple.com,2026:photo:aux:"

NOTES = {
    "semanticpersonmatte": "mediapipe selfie segmentation",
    "semanticskinmattev2": "person ∧ YCbCr skin colour",
    "semanticnonfaceskinmatte": "skin outside the face oval",
    "semanticfaceskinmatte": "face oval ∧ skin, minus eyes/brows/lips",
    "semanticnosematte": "face landmarks: nose polygon",
    "semanticlipsmatte": "face landmarks: outer lips",
    "semanticteethmattev2": "face landmarks: mouth interior (approx)",
    "semanticeyebrowsmatte": "face landmarks: both brows",
    "semanticglassesmattev2": "face landmarks: eye bands (approx)",
    "semantichandsmatte": "hand landmarks ∧ person",
    "semanticearsmatte": "face-oval edge strips (approx)",
    "semantictattoomatte": "empty: no detector",
}


def load(path: Path):
    img = Image.open(path).convert("RGB")
    scale = min(1.0, WORK_EDGE / max(img.size))
    if scale < 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)),
                         Image.LANCZOS)
    return img


def hull_mask(size, points, blur=0):
    m = Image.new("L", size, 0)
    if len(points) >= 3:
        ImageDraw.Draw(m).polygon([tuple(p) for p in points], fill=255)
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    return np.array(m) > 127


def px(landmarks, idx, size):
    w, h = size
    return [(int(landmarks[i].x * w), int(landmarks[i].y * h)) for i in idx]


def skin_colour(rgb):
    """Classic YCbCr skin rule; rgb is uint8 (H, W, 3)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return (cb >= 77) & (cb <= 130) & (cr >= 133) & (cr <= 177)


def close_open(mask):
    try:
        from scipy import ndimage
        m = ndimage.binary_closing(mask, np.ones((5, 5), bool))
        return ndimage.binary_opening(m, np.ones((3, 3), bool))
    except Exception:
        return mask


def segment(img: Image.Image):
    """-> dict of 12 boolean masks at photo resolution + per-slot notes."""
    rgb = np.array(img)
    size = img.size  # (w, h)
    zeros = np.zeros((img.height, img.width), bool)
    out = {name: None for name in MATTES}
    src = {name: NOTES[name] for name in MATTES}

    # --- person ---
    person = None
    with mp.solutions.selfie_segmentation.SelfieSegmentation(
            model_selection=1) as seg:
        res = seg.process(rgb)
    if res.segmentation_mask is not None:
        person = res.segmentation_mask > 0.5
        person = close_open(person)
    if person is None or not person.any():
        person = zeros
        src["semanticpersonmatte"] = "selfie segmentation found no person"
    out["semanticpersonmatte"] = person

    # --- face landmarks ---
    face_ok = False
    with mp.solutions.face_mesh.FaceMesh(
            static_image_mode=True, max_num_faces=1,
            refine_landmarks=True) as fm:
        res = fm.process(rgb)
    lm = None
    if res.multi_face_landmarks:
        lm = res.multi_face_landmarks[0].landmark
        face_ok = True
    if face_ok:
        oval = hull_mask(size, px(lm, FACE_OVAL, size))
        lips = hull_mask(size, px(lm, LIPS_OUTER, size))
        mouth = hull_mask(size, px(lm, LIPS_INNER, size))
        brows = (hull_mask(size, px(lm, BROW_L, size))
                 | hull_mask(size, px(lm, BROW_R, size)))
        eyes = (hull_mask(size, px(lm, EYE_L, size))
                | hull_mask(size, px(lm, EYE_R, size)))
        nose = hull_mask(size, px(lm, NOSE, size))
        w, h = size
        fx = [int(lm[i].x * w) for i in range(len(lm))]
        fy = [int(lm[i].y * h) for i in range(len(lm))]
        left, right = min(fx), max(fx)
        top, bottom = min(fy), max(fy)
        span = max(right - left, bottom - top)
        ear_w = max(span // 6, 8)
        ear_top, ear_bot = top + (bottom - top) // 3, top + (bottom - top) * 3 // 4
        ears = zeros.copy()
        ears[ear_top:ear_bot, max(0, left - ear_w):left] = True
        ears[ear_top:ear_bot, right:right + ear_w] = True
        ears &= person
        out["semanticnosematte"] = nose
        out["semanticlipsmatte"] = lips
        out["semanticteethmattev2"] = mouth
        out["semanticeyebrowsmatte"] = brows
        out["semanticglassesmattev2"] = (eyes | hull_mask(
            size, px(lm, [168, 6], size), blur=6)) & (oval | person)
        out["semanticearsmatte"] = ears
    else:
        for k in ("semanticnosematte", "semanticlipsmatte",
                  "semanticteethmattev2", "semanticeyebrowsmatte",
                  "semanticglassesmattev2", "semanticearsmatte"):
            out[k] = zeros
            src[k] = "empty: no face detected"

    # --- skin family ---
    skin = close_open(person & skin_colour(rgb))
    if face_ok:
        face = oval
        uncovered = eyes | brows | lips | nose
        out["semanticfaceskinmatte"] = face & skin & ~uncovered
        out["semanticnonfaceskinmatte"] = skin & ~face
    else:
        out["semanticfaceskinmatte"] = zeros
        out["semanticnonfaceskinmatte"] = skin
        if not face_ok:
            src["semanticfaceskinmatte"] = "empty: no face detected"
    out["semanticskinmattev2"] = skin

    # --- hands ---
    hands = zeros.copy()
    found_hands = 0
    with mp.solutions.hands.Hands(static_image_mode=True, max_num_hands=4) as hd:
        res = hd.process(rgb)
    if res.multi_hand_landmarks:
        for hl in res.multi_hand_landmarks:
            pts = [(int(lm.x * size[0]), int(lm.y * size[1]))
                   for lm in hl.landmark]
            hands |= hull_mask(size, pts, blur=4)
            found_hands += 1
    out["semantichandsmatte"] = hands & (person | skin)
    if not found_hands:
        src["semantichandsmatte"] = "empty: no hands detected"

    out["semantictattoomatte"] = zeros
    for k in MATTES:
        if out[k] is None:
            out[k] = zeros
        out[k] = np.asarray(out[k], bool)
    return out, src, face_ok


def to_768(mask):
    m = Image.fromarray((mask * 255).astype(np.uint8), "L")
    m = m.resize((W, H), Image.LANCZOS)
    return (np.array(m) > 127).astype(np.uint8) * 255


def encode_mask(mask_u8) -> tuple[bytes, bytes, list]:
    """Monochrome lossless HEVC -> (hvc1 payload, hvcC box, NAL list)."""
    buf = io.BytesIO()
    with av.open(buf, mode="w", format="hevc") as c:
        st = c.add_stream("libx265", rate=1)
        st.width, st.height = W, H
        st.pix_fmt = "gray"
        st.options = {"x265-params": "lossless=1:keyint=1"}
        fr = av.VideoFrame.from_ndarray(mask_u8, format="gray")
        for pkt in st.encode(fr):
            buf.write(bytes(pkt))
        for pkt in st.encode(None):
            buf.write(bytes(pkt))
    raw = buf.getvalue()

    # annex-B -> NAL list [(type, bytes)]; each body must END where the next
    # start code BEGINS, never include the start code itself.
    marks = []  # (start-code length, data begin)
    i = 0
    while i < len(raw) - 3:
        if raw[i:i + 4] == b"\x00\x00\x00\x01":
            marks.append((4, i + 4)); i += 4
        elif raw[i:i + 3] == b"\x00\x00\x01":
            marks.append((3, i + 3)); i += 3
        else:
            i += 1
    nals = []
    for k, (_, begin) in enumerate(marks):
        end = (marks[k + 1][1] - marks[k + 1][0]) if k + 1 < len(marks) else len(raw)
        body = raw[begin:end]
        # drop byte-stream padding before the boundary
        body = body.rstrip(b"\x00") or body
        nals.append((body[0] >> 1 & 0x3F, body))

    params = [(t, b) for t, b in nals if t in (32, 33, 34)]
    vcl = [(t, b) for t, b in nals if 16 <= t <= 21]
    if len(params) < 3 or not vcl:
        raise RuntimeError(f"unexpected HEVC NAL set: {[t for t, _ in nals]}")

    # hvcC: a full property box — native fixed header + our parameter sets.
    # (ipco stores boxes, not bare configuration payloads)
    body = bytearray(REFERENCE_HVCC)
    body.append(len(params))
    for t, b in params:
        body.append(0x80 | t)            # array header: completeness + type
        body += (1).to_bytes(2, "big")   # numNalus per array
        body += len(b).to_bytes(2, "big")  # nalUnitLength
        body += b
    hvcC = (8 + len(body)).to_bytes(4, "big") + b"hvcC" + bytes(body)

    payload = b"".join(len(b).to_bytes(4, "big") + b for _, b in vcl)
    return payload, hvcC, [t for t, _ in nals]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    photo = Path(sys.argv[1])
    outdir = Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)

    img = load(photo)
    masks, src, face_ok = segment(img)
    print(f"face detected: {face_ok}")

    pack = {"size": [W, H], "mattes": {}}
    preview = Image.new("L", (W * 4, H * 3), 0)
    for n, name in enumerate(MATTES):
        m768 = to_768(masks[name])
        payload, hvcC, nals = encode_mask(m768)
        pack["mattes"][URN_PREFIX + name] = {
            "payload": payload.hex(),
            "hvcC": hvcC.hex(),
            "note": src[name],
            "nals": nals,
            "covered_px": int((m768 > 0).sum()),
        }
        x, y = (n % 4) * W, (n // 4) * H
        preview.paste(Image.fromarray(m768, "L"), (x, y))
        print(f"  {name}: {len(payload)}B NALs={nals} px={int((m768>0).sum())}")

    (outdir / "mask-pack.json").write_text(json.dumps(pack), encoding="utf-8")
    # labelled montage: name text over each cell
    labelled = preview.convert("RGB")
    dr = ImageDraw.Draw(labelled)
    for n, name in enumerate(MATTES):
        x, y = (n % 4) * W, (n // 4) * H
        dr.text((x + 10, y + 8), name.replace("semantic", "")[:20],
                fill=(255, 60, 60))
    labelled.save(outdir / "preview.png")
    print(f"wrote {outdir/'mask-pack.json'} and preview.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
