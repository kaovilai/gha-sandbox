#!/usr/bin/env node
// UI-tree helper for the mobile live scenarios. Zero deps. Reads stdin: Android `uiautomator dump` XML or AXe
// `describe-ui` JSON (auto-detected).
//   uia.mjs find <regex>     -> prints "<cx> <cy> <label>" for the first labelled node matching; exit 1 if none
//   uia.mjs findall <regex>  -> every match, one per line
//   uia.mjs texts            -> every labelled node "<cx>,<cy> <label>" (log/diagnostic)
import { readFileSync } from "node:fs";

const [cmd, pat] = process.argv.slice(2);
const raw = readFileSync(0, "utf8");

const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");

function androidNodes(xml) {
  const out = [];
  for (const m of xml.matchAll(/<node\s[^>]*>/g)) {
    const attrs = {};
    for (const a of m[0].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    if (!b) continue;
    const [l, t, r, bt] = b.slice(1).map(Number);
    const label = attrs.text || attrs["content-desc"] || "";
    if (!label || r <= l || bt <= t) continue;
    out.push({ label, cx: Math.round((l + r) / 2), cy: Math.round((t + bt) / 2) });
  }
  return out;
}

function iosNodes(json) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const label = n.AXLabel || n.AXValue || n.title || "";
    const f = n.frame;
    if (label && f && f.width > 0 && f.height > 0) {
      out.push({ label: String(label), cx: Math.round(f.x + f.width / 2), cy: Math.round(f.y + f.height / 2) });
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(json);
  return out;
}

let nodes = [];
const body = raw.trim();
if (body.startsWith("<")) nodes = androidNodes(body);
else if (body.startsWith("{") || body.startsWith("[")) {
  try {
    nodes = iosNodes(JSON.parse(body));
  } catch {}
}

if (cmd === "texts") {
  for (const n of nodes) console.log(`${n.cx},${n.cy} ${n.label.replace(/\s+/g, " ").slice(0, 160)}`);
} else if (cmd === "find" || cmd === "findall") {
  const re = new RegExp(pat, "i");
  const hits = nodes.filter((n) => re.test(n.label));
  if (hits.length === 0) process.exit(1);
  for (const n of cmd === "find" ? hits.slice(0, 1) : hits) console.log(`${n.cx} ${n.cy} ${n.label.replace(/\s+/g, " ").slice(0, 160)}`);
} else {
  console.error("usage: uia.mjs find|findall <regex> | texts   (UI dump on stdin)");
  process.exit(2);
}
