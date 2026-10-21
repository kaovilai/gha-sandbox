// Scenario harness. Env: PAIRING_URL (authenticated app URL), OUT_DIR, SIDE.
// Writes <OUT_DIR>/<name>.png via shot(name) and <OUT_DIR>/<video>.webm on close.
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export async function run(fn, { viewport = { width: 1440, height: 900 }, video = true } = {}) {
  const out = process.env.OUT_DIR ?? "out";
  const url = process.env.PAIRING_URL;
  if (!url) throw new Error("PAIRING_URL unset");
  mkdirSync(out, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport,
    ...(video ? { recordVideo: { dir: join(out, "_video"), size: viewport } } : {}),
  });
  const page = await context.newPage();
  const shot = (name, opts = {}) => page.screenshot({ path: join(out, `${name}.png`), ...opts });

  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await fn({ page, shot, context, out });
  } finally {
    await context.close(); // flushes video
    await browser.close();
    if (video) {
      const dir = join(out, "_video");
      readdirSync(dir)
        .filter((f) => f.endsWith(".webm"))
        .forEach((f, i) => renameSync(join(dir, f), join(out, `recording${i || ""}.webm`)));
    }
  }
}
