// Pure parsing helpers shared by scripts/uia.mjs and mockkit/test/uia.test.mjs. Zero deps, no I/O.
//
// A "node" is {label, cx, cy, src}: a labelled, visible UI element (centre in device pixels).
//   src = "tree" for uiautomator / Dump.java XML and AXe describe-ui JSON, "ocr" for OCR segments.

export const decode = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");

export function androidNodes(xml) {
  const out = [];
  for (const m of xml.matchAll(/<node\s[^>]*>/g)) {
    const attrs = {};
    for (const a of m[0].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
    if (!b) continue;
    const [l, t, r, bt] = b.slice(1).map(Number);
    const label = attrs.text || attrs["content-desc"] || "";
    if (!label || r <= l || bt <= t) continue;
    out.push({ label, cx: Math.round((l + r) / 2), cy: Math.round((t + bt) / 2), src: "tree" });
  }
  return out;
}

export function iosNodes(json) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object") return;
    const label = n.AXLabel || n.AXValue || n.title || "";
    const f = n.frame;
    if (label && f && f.width > 0 && f.height > 0) {
      out.push({ label: String(label), cx: Math.round(f.x + f.width / 2), cy: Math.round(f.y + f.height / 2), src: "tree" });
    }
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(json);
  return out;
}

// ---- OCR ---------------------------------------------------------------------------------------------------------

// Tesseract TSV (output of `tesseract img out tsv`, also tesseract.js `{tsv:true}`) -> words {text,l,t,r,b,conf,line}.
// Columns: level page block par line word left top width height conf text. Level 5 = word.
export function parseTsv(tsv, minConf = 30) {
  const words = [];
  for (const row of String(tsv).split(/\r?\n/)) {
    const c = row.split("\t");
    if (c.length < 12 || c[0] !== "5") continue;
    const conf = Number(c[10]);
    const text = c.slice(11).join("\t").trim();
    if (!text || !(conf >= minConf)) continue;
    const [l, t, w, h] = [c[6], c[7], c[8], c[9]].map(Number);
    if (![l, t, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    words.push({ text, l, t, r: l + w, b: t + h, conf, line: `${c[2]}.${c[3]}.${c[4]}` });
  }
  return words;
}

// Add the words of a later OCR pass (e.g. thresholded image) that the earlier pass did not already find: a word is "new" when
// its centre is not inside any existing word's box.
export function mergeWords(base, extra) {
  const out = [...base];
  for (const w of extra) {
    const cx = (w.l + w.r) / 2;
    const cy = (w.t + w.b) / 2;
    if (!out.some((o) => cx >= o.l && cx <= o.r && cy >= o.t && cy <= o.b)) out.push(w);
  }
  return out;
}

// Words -> segments. Words are first clustered into text lines by vertical overlap, then each line is split wherever the
// horizontal gap exceeds `gapFactor` x the line's median word height, so separate buttons on one row ("Cancel   Decline
// Approve") become separate tap targets instead of one wide line whose centre hits nothing.
// Returns [{text,l,t,r,b,kind}] with all segments first, followed by whole lines whose text differs from a single segment
// (so a regex spanning a wide gap still matches, but `find` prefers the tight segment boxes for tapping).
export function ocrSegments(words, gapFactor = 1.6) {
  const ws = words.filter((w) => w.text && w.r > w.l && w.b > w.t).map((w) => ({ ...w }));
  ws.sort((a, b) => (a.t + a.b) / 2 - (b.t + b.b) / 2 || a.l - b.l);
  const lines = [];
  for (const w of ws) {
    const cy = (w.t + w.b) / 2;
    const home = lines.find((ln) => cy > ln.t && cy < ln.b);
    if (home) {
      home.words.push(w);
      home.t = Math.min(home.t, w.t);
      home.b = Math.max(home.b, w.b);
    } else lines.push({ t: w.t, b: w.b, words: [w] });
  }
  const segs = [];
  const full = [];
  for (const ln of lines) {
    ln.words.sort((a, b) => a.l - b.l);
    const hs = ln.words.map((w) => w.b - w.t).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)];
    let cur = null;
    for (const w of ln.words) {
      if (cur && w.l - cur.r <= gapFactor * medH) {
        cur.text += " " + w.text;
        cur.r = Math.max(cur.r, w.r);
        cur.t = Math.min(cur.t, w.t);
        cur.b = Math.max(cur.b, w.b);
      } else {
        cur = { text: w.text, l: w.l, t: w.t, r: w.r, b: w.b, kind: "seg" };
        segs.push(cur);
      }
    }
    const text = ln.words.map((w) => w.text).join(" ");
    full.push({ text, l: ln.words[0].l, t: ln.t, r: Math.max(...ln.words.map((w) => w.r)), b: ln.b, kind: "line" });
  }
  const segTexts = new Set(segs.map((s) => s.text));
  return [...segs, ...full.filter((f) => !segTexts.has(f.text))];
}

export function ocrNodes(doc) {
  return (doc.segments ?? []).map((s) => ({
    label: String(s.text),
    cx: Math.round((s.l + s.r) / 2),
    cy: Math.round((s.t + s.b) / 2),
    src: "ocr",
  }));
}

// stdin autodetect: Android XML | AXe JSON | OCR json ({source:"ocr", segments:[...]})
export function parseNodes(raw) {
  const body = String(raw).trim();
  if (body.startsWith("<")) return androidNodes(body);
  if (body.startsWith("{") || body.startsWith("[")) {
    try {
      const j = JSON.parse(body);
      if (j && j.source === "ocr") return ocrNodes(j);
      return iosNodes(j);
    } catch {
      return [];
    }
  }
  return [];
}

export const fmt = (n) => `${n.cx} ${n.cy} ${n.label.replace(/\s+/g, " ").slice(0, 160)}`;

export function findNodes(nodes, pattern) {
  const re = new RegExp(pattern, "i");
  return nodes.filter((n) => re.test(n.label.replace(/\s+/g, " ").trim()));
}
