#!/usr/bin/env node
// UI-tree helper for the mobile live scenarios. Zero deps. Reads stdin: Android `uiautomator dump` / scripts/android-dump XML,
// AXe `describe-ui` JSON, or OCR json from scripts/ocr.mjs (auto-detected; parsing lives in uia-lib.mjs, unit-tested).
//   uia.mjs find <regex>     -> prints "<cx> <cy> <label>" for the first labelled node matching; exit 1 if none
//   uia.mjs findall <regex>  -> every match, one per line
//   uia.mjs texts            -> every labelled node "<cx>,<cy> <label>" (log/diagnostic)
//   uia.mjs count            -> number of labelled nodes (0 = no usable tree: NOT proof of anything)
import { readFileSync } from "node:fs";
import { findNodes, fmt, parseNodes } from "./uia-lib.mjs";

const [cmd, pat] = process.argv.slice(2);
const nodes = parseNodes(readFileSync(0, "utf8"));

if (cmd === "texts") {
  for (const n of nodes) console.log(`${n.cx},${n.cy} ${n.label.replace(/\s+/g, " ").slice(0, 160)}`);
} else if (cmd === "count") {
  console.log(nodes.length);
} else if (cmd === "find" || cmd === "findall") {
  const hits = findNodes(nodes, pat);
  if (hits.length === 0) process.exit(1);
  for (const n of cmd === "find" ? hits.slice(0, 1) : hits) console.log(fmt(n));
} else {
  console.error("usage: uia.mjs find|findall <regex> | texts | count   (UI dump on stdin)");
  process.exit(2);
}
