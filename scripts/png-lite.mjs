// Minimal PNG gray decode/encode (zero deps) so ocr.mjs can feed tesseract threshold variants of a screenshot:
// white-on-blue button labels ("Allow once") vanish in a plain pass but are crisp ink after a brightness threshold.
import { crc32 as zcrc32, deflateSync, inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let table;
function crc32(buf) {
  if (typeof zcrc32 === "function") return zcrc32(buf) >>> 0;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// -> {w, h, gray: Uint8Array(w*h)} luminance; supports 8-bit gray / gray+alpha / RGB / RGBA, non-interlaced
export function decodePngGray(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(ctype)) throw new Error(`unsupported PNG (depth ${depth} type ${ctype} interlace ${interlace})`);
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("short PNG data");
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 0xff;
    }
  }
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * bpp;
    gray[i] = ctype === 0 || ctype === 4 ? px[o] : Math.round(0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]);
  }
  return { w, h, gray };
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodeGrayPng(w, h, gray) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // depth
  ihdr[9] = 0; // gray
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(gray.buffer, gray.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ink = black on white wherever the pixel is "text". mode "bright": text is lighter than `t` (light text on dark/blue UI);
// mode "dark": text is darker than `t`.
export function threshold(gray, mode, t) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = (mode === "bright" ? gray[i] > t : gray[i] < t) ? 0 : 255;
  return out;
}
