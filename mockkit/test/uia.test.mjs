import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { decodePngGray, encodeGrayPng, threshold } from "../../scripts/png-lite.mjs";
import { androidNodes, findNodes, iosNodes, mergeWords, ocrNodes, ocrSegments, parseNodes, parseTsv } from "../../scripts/uia-lib.mjs";

const node = (text, desc, b) => `<node index="1" text="${text}" content-desc="${desc}" bounds="${b}"></node>`;

test("androidNodes: labels, bounds centres, entities, skips unlabelled / zero-size", () => {
  const xml = `<hierarchy>${node("Step 5 of 8", "", "[0,100][200,140]")}${node("", "More options", "[280,32][320,80]")}${node("", "", "[0,0][10,10]")}${node("zero", "", "[5,5][5,9]")}${node("a &amp; b&#10;c &lt;d&gt; &quot;q&quot;", "", "[0,0][10,10]")}</hierarchy>`;
  const n = androidNodes(xml);
  assert.deepEqual(
    n.map((x) => [x.label, x.cx, x.cy, x.src]),
    [
      ["Step 5 of 8", 100, 120, "tree"],
      ["More options", 300, 56, "tree"],
      ['a & b\nc <d> "q"', 5, 5, "tree"],
    ],
  );
});

test("an empty or truncated tree has zero labelled nodes (never proof)", () => {
  assert.equal(parseNodes("").length, 0);
  assert.equal(parseNodes("<hierarchy rotation=\"0\"></hierarchy>").length, 0);
  assert.equal(parseNodes("ERROR: could not get idle state.").length, 0);
  assert.equal(parseNodes("{not json").length, 0);
});

test("iosNodes + parseNodes autodetect AXe JSON", () => {
  const json = JSON.stringify([{ AXLabel: "Approve", frame: { x: 10, y: 20, width: 100, height: 40 }, children: [{ AXValue: "v", frame: { x: 0, y: 0, width: 4, height: 4 } }] }]);
  assert.deepEqual(parseNodes(json).map((n) => n.label), ["Approve", "v"]);
  assert.deepEqual(iosNodes(JSON.parse(json))[0], { label: "Approve", cx: 60, cy: 40, src: "tree" });
});

test("findNodes: case-insensitive, whitespace-normalised, anchors apply to the label", () => {
  const nodes = [
    { label: "Approval needed", cx: 1, cy: 2, src: "tree" },
    { label: "Approve\n", cx: 3, cy: 4, src: "tree" },
    { label: "Allow once", cx: 5, cy: 6, src: "tree" },
  ];
  assert.equal(findNodes(nodes, "^(Approve|Allow once)$")[0].cx, 3);
  assert.equal(findNodes(nodes, "approval needed|nothing").length, 1);
  assert.equal(findNodes(nodes, "^Strict").length, 0);
});

const row = (line, word, l, t, w, h, conf, text, level = 5) => [level, 1, 1, 1, line, word, l, t, w, h, conf, text].join("\t");

test("parseTsv keeps confident level-5 words only", () => {
  const tsv = ["level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext", row(1, 0, 0, 0, 100, 50, -1, "", 4), row(1, 1, 10, 20, 60, 30, 96.5, "Step"), row(1, 2, 80, 20, 20, 30, 12, "junk"), row(1, 3, 110, 20, 30, 30, 90, "  "), row(1, 4, 150, 20, 0, 30, 90, "flat")].join("\n");
  assert.deepEqual(parseTsv(tsv), [{ text: "Step", l: 10, t: 20, r: 70, b: 50, conf: 96.5, line: "1.1.1" }]);
  assert.equal(parseTsv(tsv, 10).length, 2);
});

const W = (text, l, t, r, b) => ({ text, l, t, r, b, conf: 90 });

test("ocrSegments: one row, wide gap -> separate tap targets; tight words -> one segment; whole line kept for regexes", () => {
  const words = [W("Allow", 76, 1400, 160, 1440), W("once", 170, 1400, 240, 1440), W("Allow", 465, 1400, 550, 1440), W("session", 560, 1400, 690, 1440), W("Decline", 140, 1550, 260, 1590)];
  const segs = ocrSegments(words);
  const texts = segs.map((s) => s.text);
  assert.deepEqual(texts.slice(0, 3), ["Allow once", "Allow session", "Decline"]);
  assert.ok(texts.includes("Allow once Allow session"));
  const nodes = ocrNodes({ segments: segs });
  const hit = findNodes(nodes, "^(Approve|Allow once)$")[0];
  assert.equal(hit.cx, 158);
  assert.equal(hit.cy, 1420);
  assert.equal(hit.src, "ocr");
});

test("ocrSegments: lines cluster by vertical overlap; words sorted left to right", () => {
  const words = [W("of", 200, 103, 240, 140), W("Step", 20, 100, 110, 141), W("5", 130, 99, 170, 139), W("8:", 250, 101, 300, 142), W("Next", 20, 300, 120, 340)];
  const segs = ocrSegments(words);
  assert.equal(segs[0].text, "Step 5 of 8:");
  assert.equal(segs[1].text, "Next");
  assert.equal(segs.length, 2);
});

test("mergeWords adds only words not already covered", () => {
  const base = [W("Decline", 100, 100, 200, 140)];
  const extra = [W("Declin", 105, 102, 190, 138), W("Allow", 300, 100, 400, 140)];
  assert.deepEqual(mergeWords(base, extra).map((w) => w.text), ["Decline", "Allow"]);
});

test("parseNodes autodetects OCR json", () => {
  const doc = { source: "ocr", w: 1080, h: 1920, segments: [{ text: "Step 5 of 8", l: 50, t: 1440, r: 450, b: 1480, kind: "seg" }] };
  const n = parseNodes(JSON.stringify(doc));
  assert.equal(n.length, 1);
  assert.equal(n[0].src, "ocr");
  assert.equal(n[0].cx, 250);
});

test("png-lite: gray roundtrip + threshold", () => {
  const w = 5, h = 3;
  const gray = Uint8Array.from({ length: w * h }, (_, i) => i * 17);
  const out = decodePngGray(encodeGrayPng(w, h, gray));
  assert.deepEqual([out.w, out.h], [w, h]);
  assert.deepEqual(Array.from(out.gray), Array.from(gray));
  assert.deepEqual(Array.from(threshold(Uint8Array.from([10, 200, 255]), "bright", 180)), [255, 0, 0]);
  assert.deepEqual(Array.from(threshold(Uint8Array.from([10, 200, 255]), "dark", 180)), [0, 255, 255]);
});

// RGBA PNG built by hand with Sub (1) and Up (2) filters, as screencap output uses filters per row
function rgbaPng(w, h, px, filters) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = filters[y];
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      raw[y * (stride + 1) + 1 + x] = (v - (f === 1 ? a : f === 2 ? b : 0)) & 0xff;
    }
  }
  const gray = encodeGrayPng(1, 1, Uint8Array.from([0])); // borrow signature + chunk framing, then swap IHDR/IDAT
  const sig = gray.subarray(0, 8);
  const mk = (type, data) => {
    const c = Buffer.alloc(12 + data.length);
    c.writeUInt32BE(data.length, 0);
    c.write(type, 4, "latin1");
    data.copy(c, 8);
    return c; // CRC left zero: decodePngGray does not verify it
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([sig, mk("IHDR", ihdr), mk("IDAT", deflateSync(raw)), mk("IEND", Buffer.alloc(0))]);
}

test("png-lite: RGBA decode through Sub/Up filters -> luminance", () => {
  const w = 3, h = 2;
  const px = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 128, 128, 128, 255]);
  const out = decodePngGray(rgbaPng(w, h, px, [1, 2]));
  assert.deepEqual(Array.from(out.gray), [255, 0, 76, 29, 150, 128]);
});
