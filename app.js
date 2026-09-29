import { upgrade, Unsupported } from "./src/style3.js";
import { analyzePhoto } from "./src/segment.js";

const $ = (s) => document.querySelector(s);
const drop = $("#drop");
const input = $("#file");
const list = $("#list");
const skinToggle = $("#skin");
const maskInput = $("#masks");
const maskRow = $("#maskrow");

// The manual mask-pack row only earns its keep where the browser cannot encode
// HEVC (everything except Apple platforms). iPadOS masquerades as desktop
// Safari — "Macintosh" UA plus touch — so check both signals.
const APPLE_UA = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function syncMaskRow() {
  maskRow.hidden = !(skinToggle.checked && !APPLE_UA);
}
skinToggle.addEventListener("change", syncMaskRow);
syncMaskRow();
const maskStatus = $("#maskstatus");

// Optional real-mask pack from tools/make_masks.py; once loaded it takes
// precedence over the transplant toggle for every photo.
let maskPack = null;
const MASK_DEFAULT_TEXT = maskStatus.textContent.trim();

maskInput.addEventListener("change", async () => {
  const file = maskInput.files[0];
  try {
    if (!file) {
      maskPack = null;
      maskStatus.classList.remove("loaded", "error");
      maskStatus.textContent = MASK_DEFAULT_TEXT;
      return;
    }
    const pack = JSON.parse(await file.text());
    if (!pack.mattes || !Object.keys(pack.mattes).length)
      throw new Error("文件里没有 mattes 条目");
    maskPack = pack.mattes;
    maskStatus.classList.remove("error");
    maskStatus.classList.add("loaded");
    maskStatus.textContent = `已载入掩码包：${Object.keys(maskPack).length} 张真实掩码`
      + "（优先级最高，跳过自动分析）——点上方区域继续选照片。";
  } catch (e) {
    maskPack = null;
    maskStatus.classList.remove("loaded");
    maskStatus.classList.add("error");
    maskStatus.textContent = `掩码包读取失败：${e.message || e}——请换一份 make_masks.py 生成的文件。`;
  }
});

// iOS names edited copies IMG_0001.HEIC -> IMG_E0001.HEIC; mirror that.
// Other names get an _E suffix — the convention has no IMG_-less spelling.
function outName(name) {
  const stem = name.replace(/\.(heic|heif)$/i, "");
  return (/^IMG_/i.test(stem) ? stem.replace(/^IMG_/i, "IMG_E") : `${stem}_E`) + ".HEIC";
}

function sniff(bytes) {
  if (bytes.length < 12) return false;
  const t = String.fromCharCode(...bytes.slice(4, 8));
  const brands = String.fromCharCode(...bytes.slice(8, Math.min(bytes.length, 32)));
  return t === "ftyp" && /heic|heix|hevc|mif1|msf1/.test(brands);
}

function row(file) {
  const el = document.createElement("div");
  el.className = "row";
  el.innerHTML = `<div class="name"></div><ul class="notes"></ul><div class="action"></div>`;
  el.querySelector(".name").textContent = file.name;
  list.prepend(el);
  return el;
}

async function handle(files) {
  for (const file of files) {
    const el = row(file);
    const notes = el.querySelector(".notes");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!sniff(bytes)) throw new Unsupported("不是 HEIC 照片");

      // Priority: a manually loaded pack wins; otherwise analyze the photo in
      // the browser (models load once, ~4 MB); when the browser cannot encode
      // HEVC the analysis stands down and upgrade() falls back to the toggle.
      // 柔肤（实验性）是掩码工作的总开关：关闭时不分析也不用载入的包，
      // 所有槽位走空占位，其余质感（颗粒/光晕/胶片）不受影响。
      let masks = skinToggle.checked ? maskPack : null;
      let pre = [];
      if (skinToggle.checked && !masks) {
        const status = document.createElement("li");
        status.textContent = "正在本机分析（照片不会离开设备）…";
        notes.appendChild(status);
        try {
          const r = await analyzePhoto(file, (t) => { status.textContent = `${t}…`; });
          masks = r.masks;
          pre = r.notes;
        } catch (e) {
          pre = [`自动分析不可用：${e.message || e}`];
        }
        status.remove();
      }

      const { bytes: out, notes: log } = upgrade(bytes, {
        reuseSkinMatte: skinToggle.checked,
        masks,
      });
      for (const n of [...pre, ...log]) {
        const li = document.createElement("li");
        li.textContent = n;
        notes.appendChild(li);
      }
      const name = outName(file.name);
      const a = document.createElement("a");
      a.className = "btn";
      a.download = name;
      a.href = URL.createObjectURL(new Blob([out], { type: "image/heic" }));
      a.textContent = `下载 ${name}`;
      el.querySelector(".action").appendChild(a);
    } catch (e) {
      const li = document.createElement("li");
      li.className = "err";
      li.textContent = e instanceof Unsupported ? e.message : `出错了：${e.message || e}`;
      notes.appendChild(li);
    }
  }
}

drop.addEventListener("click", () => input.click());
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  handle([...e.dataTransfer.files]);
});
input.addEventListener("change", () => handle([...input.files]));
