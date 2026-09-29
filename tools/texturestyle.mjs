// 读 / 改照片 MakerNote 里的摄影风格3 质感记录（tag 84）。
//
//   node tools/texturestyle.mjs PHOTO.HEIC                        只报告
//   node tools/texturestyle.mjs PHOTO.HEIC OUT.HEIC --preset=2    改并写出
//   node tools/texturestyle.mjs PHOTO.HEIC OUT.HEIC --grain=0.5 --intensity=0.8
//
// 供体（iPhone 18 Pro）实测值：
//   preset=1(Standard) intensity=1.0 grain=0.0
//   originalInsteadOfReversibility=false renderingVersion=1
//   info 0..7 = 1, -0.156, 0.0355, 1, 1, 1, 4, 0
//
// preset 映射：1=Standard 2=Soft(柔肤) 3=Studio 4=Filmic(胶片) 5=Glowy(光晕)。
//
// 改写全程等长：Exif 负载长度不变，所以容器不需要重建，只在 Exif 条目的文件
// 偏移处原位替换几个字节。共享的取值会先改指到字节相同的对象上再覆写，
// info 字段因此不受影响。intensity 的取值对象被占满、找不到可借的副本，会
// 被拒绝——那需要重建 plist（变长）乃至整条 EXIF 链。

import { readFileSync, writeFileSync } from "node:fs";
import { readGraph, payloadOf } from "../src/items.js";
import { findTextureStyleRecord, readTextureStyle, sharedWith, canUnshare, patchPhoto }
  from "../src/texturestyle.js";

const args = process.argv.slice(2);
const [input, output] = args.filter((a) => !a.startsWith("--"));
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};
const num = (name) => {
  const raw = opt(name);
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`--${name}=${raw} 不是数字`);
  return v;
};

try {
  if (!input) {
    console.log("usage: node tools/texturestyle.mjs PHOTO.HEIC [OUT.HEIC]"
      + " [--preset=N] [--intensity=F] [--grain=F] [--reversibility=0|1] [--renderingVersion=N]");
    process.exit(2);
  }

  const src = new Uint8Array(readFileSync(input));
  const graph = readGraph(src);
  const exifId = [...graph.items.values()].find((it) => it.type === "Exif")?.id;
  if (exifId === undefined) throw new Error("照片没有 Exif 条目");
  const exif = payloadOf(graph, exifId);

  const rec = findTextureStyleRecord(exif);
  if (!rec) throw new Error("没找到 tag 84 质感记录（不是 18 Pro / iOS 27 照片？）");
  const s = readTextureStyle(rec);
  const NAMES = { 1: "Standard 标准", 2: "Soft 柔肤", 3: "Studio", 4: "Filmic 胶片", 5: "Glowy 光晕" };

  console.log(`${input}  (Exif 条目 id ${exifId}, 记录 @ ${rec.start}..${rec.end})`);
  console.log(`  preset  = ${s.preset}  ${NAMES[s.preset] ?? "?"}`);
  console.log(`  intensity = ${s.intensity}`);
  console.log(`  grain     = ${s.grain}`);
  console.log(`  originalInsteadOfReversibility = ${s.originalInsteadOfReversibility}`);
  console.log(`  renderingVersion = ${s.renderingVersion}`);
  console.log(`  info 0..7 = ${JSON.stringify(s.info)}`);
  for (const [field, key] of [["preset", "8"], ["intensity", "9"], ["grain", "10"],
    ["originalInsteadOfReversibility", "11"], ["renderingVersion", "12"]]) {
    const sharers = sharedWith(rec, key);
    if (!sharers.length) continue;
    console.log(canUnshare(exif, rec, key)
      ? `  · ${field} 与键 ${sharers.join("、")} 共享取值，可改指后覆写`
      : `  · ${field} 与键 ${sharers.join("、")} 共享取值，且无可借副本 —— 改不了`);
  }

  const patch = {};
  const preset = num("preset"), intensity = num("intensity"), grain = num("grain");
  const rev = opt("reversibility"), rver = num("renderingVersion");
  if (preset !== undefined) patch.preset = preset;
  if (intensity !== undefined) patch.intensity = intensity;
  if (grain !== undefined) patch.grain = grain;
  if (rev !== undefined) patch.originalInsteadOfReversibility = rev !== "0";
  if (rver !== undefined) patch.renderingVersion = rver;

  if (!Object.keys(patch).length) {
    console.log("\n只读模式，未做修改。");
    process.exit(0);
  }

  const { bytes, notes } = patchPhoto(src, patch);
  console.log(`\n改写 ${JSON.stringify(patch)}`);
  for (const n of notes) console.log(`  · ${n}`);
  if (!output) {
    console.log("未指定输出文件，只做了内存中的试算。");
    process.exit(0);
  }
  writeFileSync(output, bytes);
  console.log(`已写出 ${output}（${bytes.length} 字节，与输入等长）`);
} catch (e) {
  console.error(`错误：${e.message}`);
  process.exit(1);
}
