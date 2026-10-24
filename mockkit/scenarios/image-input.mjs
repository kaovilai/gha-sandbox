import { S } from "../lib/ir.mjs";

// Image attachments (Claude user message `image` content blocks, base64). The mock decodes the PNG/GIF header and tells what it
// "sees". Without images it says so. Other adapters do not receive image blocks (ctx.images stays empty).
export default {
  id: "image-input",
  title: "Image attachment",
  steps: (ctx) => {
    const imgs = ctx.images ?? [];
    if (imgs.length === 0) return [S.say("I did not receive any image blocks with that message.")];
    const lines = imgs.map((i, n) => `${n + 1}. ${i.mediaType}${i.width ? `, ${i.width}x${i.height} px` : ""}, ${i.bytes} bytes`);
    return [S.say(`I received ${imgs.length} image${imgs.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}\n\nThe image is a small mock test picture.`)];
  },
};
