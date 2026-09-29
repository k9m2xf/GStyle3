// Headless build: inject the Styles 3 contract (optionally with a real mask
// pack) into one photo.
//
//   node tools/build.mjs IN.HEIC OUT.HEIC [--masks mask-pack.json] [--no-skin]
//
// The mask pack comes from tools/make_masks.py. Without it the tool behaves
// like the web page: old-skin transplant for the four skin slots, empty
// placeholders elsewhere.

import { readFileSync, writeFileSync } from "node:fs";
import { upgrade } from "../src/style3.js";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));
const masksArg = args.find((a) => a.startsWith("--masks="))?.slice(8)
  ?? (args.includes("--masks") ? args[args.indexOf("--masks") + 1] : null);
if (files.length < 2) {
  console.log("usage: node tools/build.mjs IN.HEIC OUT.HEIC [--masks mask-pack.json] [--no-skin]");
  process.exit(2);
}
const [input, output] = files;

let masks = null;
if (masksArg) {
  const pack = JSON.parse(readFileSync(masksArg, "utf8"));
  masks = pack.mattes;
}

const { bytes, notes } = upgrade(new Uint8Array(readFileSync(input)), {
  reuseSkinMatte: !args.includes("--no-skin"),
  masks,
});
writeFileSync(output, bytes);
console.log(`wrote ${output} (${bytes.length} bytes)`);
for (const n of notes) console.log(`  · ${n}`);
