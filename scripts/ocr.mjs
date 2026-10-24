#!/usr/bin/env node
// OCR fallback for the mobile live scenarios (used only when no accessibility tree can be had).
//   ocr.mjs <screenshot.png>   -> prints {source:"ocr", w, h, segments:[{text,l,t,r,b,kind}]} (device pixels) on stdout
// tesseract.js (wasm, pure npm) is resolved from $OCR_HOME/node_modules (default ~/.cache/t3-ocr), eng.traineddata is cached there.
// Install: npm i --prefix $OCR_HOME tesseract.js@6   (scripts/mobile-live.sh does this lazily and CI caches $OCR_HOME).
// Passes: raw screenshot, then a brightness-thresholded copy (white labels on blue/red buttons: "Allow once", "Decline") whose
// extra words are merged in.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodePngGray, encodeGrayPng, threshold } from "./png-lite.mjs";
import { mergeWords, ocrSegments, parseTsv } from "./uia-lib.mjs";

const png = process.argv[2];
if (!png) {
  console.error("usage: ocr.mjs <png>");
  process.exit(2);
}
const home = process.env.OCR_HOME || join(homedir(), ".cache", "t3-ocr");
mkdirSync(join(home, "lang"), { recursive: true });
const require = createRequire(join(home, "node_modules", "_.js"));
const { createWorker } = require("tesseract.js");

const buf = readFileSync(png);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
const worker = await createWorker("eng", 1, { cachePath: join(home, "lang"), logger: () => {} });
// psm 11 = sparse text: UI screens are scattered labels, not paragraphs
await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" });
const run = async (img) => parseTsv((await worker.recognize(img, {}, { tsv: true })).data.tsv ?? "");

let words = await run(buf);
try {
  const g = decodePngGray(buf);
  words = mergeWords(words, await run(encodeGrayPng(g.w, g.h, threshold(g.gray, "bright", 200))));
} catch (e) {
  console.error(`ocr: threshold pass skipped: ${e.message}`);
}
await worker.terminate();
process.stdout.write(JSON.stringify({ source: "ocr", w, h, segments: ocrSegments(words) }) + "\n");
