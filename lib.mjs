// Scenario harness. Env: APP_URL (URL to open; legacy PAIRING_URL accepted), OUT_DIR, SIDE.
// Writes <OUT_DIR>/<name>.png via shot(name) and <OUT_DIR>/<video>.webm on close.
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// `init(context)` (optional) runs before the first navigation, e.g. context.addInitScript(...).
export async function run(fn, { viewport = { width: 1440, height: 900 }, video = true, init, storageState } = {}) {
  const out = process.env.OUT_DIR ?? "out";
  const url = process.env.APP_URL ?? process.env.PAIRING_URL;
  if (!url) throw new Error("APP_URL unset");
  mkdirSync(out, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport,
    ...(storageState ? { storageState } : {}),
    ...(video ? { recordVideo: { dir: join(out, "_video"), size: viewport } } : {}),
  });
  if (init) await init(context);
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
