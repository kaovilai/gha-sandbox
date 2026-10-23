// Runs mockkit UI drivers INSIDE the real t3code Electron window (built app, Xvfb), one isolated app per scenario.
//   MOCK_PROVIDER = grok (default) | codex | both: provider flavor the drivers run against (see resolveIds).
//   SCENARIOS = comma list: driver ids, short prefixes ("s03", "dk02"), or pack names from mockkit/packs.json ("desktop", ...).
// Web drivers (mockkit/scenarios-ui) are reused unchanged: Playwright attaches over CDP (connectOverCDP) to the Electron renderer.
// Desktop-only drivers (mockkit/scenarios-desktop, ids dk*) additionally get `native` (xdotool + real-desktop shots).
// Evidence: the real desktop is recorded with ffmpeg x11grab (<id>.mp4); shot(name) = `import -window root` (window chrome and
// native popups included) except shots with a `clip` option, which are Playwright element crops of the renderer.
// Files land flat in $OUT_DIR as <id>-<name>.png and <id>.mp4. Env: DISPLAY, MOCKKIT_TARGET, OUT_DIR, DESKTOP_W/H.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { labelOf, resolveScenarios } from "../../mockkit/lib/resolve.mjs";
import { bootDesktop } from "../../mockkit/lib/desktop.mjs";
import { native, rootShot, sleep, windowTree } from "../../mockkit/lib/native.mjs";
import { buildMaskRules, installMaskPage, maskNow } from "../../mockkit/lib/mask.mjs";
import { assertShell, dumpPage } from "../../mockkit/lib/ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [join(here, "../../mockkit/scenarios-ui"), join(here, "../../mockkit/scenarios-desktop")];
const out = process.env.OUT_DIR ?? "out";
const tmp = process.env.RUNNER_TEMP || "/tmp";
const W = Number(process.env.DESKTOP_W || 1440);
const H = Number(process.env.DESKTOP_H || 900);
const display = process.env.DISPLAY || ":99";

const found = new Map(); // id -> file
for (const d of dirs) for (const f of existsSync(d) ? readdirSync(d) : []) if (f.endsWith(".mjs")) found.set(f.slice(0, -4), join(d, f));
const drivers = [...found.keys()].sort();
const packs = JSON.parse(readFileSync(join(here, "../../mockkit/packs.json"), "utf8"));
// Provider flavor per scenario (mockkit/lib/resolve.mjs): "@codex" suffix, a "codex" pack (codex, desktop-codex), or env MOCK_PROVIDER.
const envProv = (process.env.MOCK_PROVIDER || "grok").toLowerCase();
const resolveIds = (spec) => resolveScenarios(spec, { packs, found, drivers, envProv });
const spec = (process.env.SCENARIOS || "").trim() || "desktop";
const ids = resolveIds(spec);
console.log(`desktop scenarios (${spec}, MOCK_PROVIDER=${envProv}): ${ids.map(labelOf).join(" ")}`);
mkdirSync(out, { recursive: true });

// ffmpeg x11grab of the whole display; stop() asks ffmpeg to finalize ('q') so the mp4 is playable.
function startRecording(file) {
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", `${W}x${H}`, "-framerate", "15", "-i", display, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", file], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  const done = new Promise((r) => ff.on("exit", r));
  return {
    stop: async () => {
      try {
        ff.stdin.write("q");
        ff.stdin.end();
      } catch {}
      const t = setTimeout(() => ff.kill("SIGTERM"), 15_000);
      await done;
      clearTimeout(t);
    },
  };
}

async function attach(app, id) {
  const browser = await chromium.connectOverCDP(app.cdpUrl);
  const deadline = Date.now() + 60_000;
  let page = null;
  while (!page && Date.now() < deadline) {
    for (const c of browser.contexts()) {
      page = c.pages().find((p) => /^(https?|t3code):\/\//.test(p.url()) && !/devtools/i.test(p.url())) ?? page;
    }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error(`cdp: no app page for ${id}; pages=${browser.contexts().flatMap((c) => c.pages().map((p) => p.url())).join(",")}`);
  // connectOverCDP has no emulated viewport: expose the real window size to drivers that read it (S03 crops).
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  page.viewportSize = () => size;
  console.log(`attached over CDP: ${page.url().replace(/[?#].*/, "")} inner=${size.width}x${size.height}`);
  return { browser, page };
}

function printMockFrames(mockLog, id) {
  try {
    const frames = readFileSync(mockLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const prompts = frames.filter((f) => f.dir === "prompt").map((f) => `turn=${f.turn} scenario=${f.scenario} queued=${f.queued}`);
    console.log(`mock ${id}: ${frames.length} frames; prompts: ${prompts.join(" | ")}`);
  } catch (e) {
    console.log(`mock log ${id} unreadable: ${e.message}`);
  }
}

const results = [];
let bootFailures = 0;
for (const entry of ids) {
  const id = labelOf(entry); // evidence file prefix ("codex-<driver>" for Codex runs)
  if (bootFailures >= 2) {
    console.log(`RESULT ${id} SKIP (2 consecutive boot failures; not burning CI minutes)`);
    results.push([id, false]);
    continue;
  }
  const file = found.get(entry.id);
  if (!file) {
    console.log(`RESULT ${id} FAIL (no driver; known: ${drivers.join(", ")}; packs: ${Object.keys(packs).join(", ")})`);
    results.push([id, false]);
    continue;
  }
  const mod = await import(pathToFileURL(file).href);
  console.log(`::group::desktop scenario ${id} (provider ${entry.prov})`);
  let ok = true;
  let app;
  let rec;
  let browser;
  try {
    try {
      // seed/settings.mjs (run by bootDesktop) reads MOCK_PROVIDER: which mock providers are READY; the driver runs against entry.prov
      process.env.MOCK_PROVIDER = mod.meta?.seed?.[entry.prov] ?? entry.prov;
      app = await bootDesktop({ id });
      bootFailures = 0;
    } catch (e) {
      bootFailures += 1;
      throw e;
    }
    const att = await attach(app, id);
    browser = att.browser;
    const page = att.page;
    await assertShell(page, `desktop shell (${id})`, 90_000);
    // mask runner hostname / absolute paths in the renderer DOM (root X11 captures and the x11grab video show the masked text)
    const maskRules = buildMaskRules({ ws: app.ws, root: app.root });
    await installMaskPage(page, maskRules);
    const nat = native(app.win);
    const env = { ...process.env, MOCKKIT_PROVIDER: entry.prov, MOCKKIT_WS: app.ws, MOCK_CONTROL_DIR: app.ctl, MOCK_LOG: app.mockLog };
    process.env.APP_URL = page.url();
    writeFileSync(join(out, `${id}-windows.txt`), windowTree());
    rec = startRecording(join(out, `${id}.mp4`));
    await sleep(800);
    const shot = async (name, opts = {}) => {
      const path = join(out, `${id}-${name}.png`);
      await maskNow(page, maskRules);
      if (opts.clip) return page.screenshot({ path, ...opts });
      return rootShot(path);
    };
    try {
      await mod.default({ page, shot, env, native: nat });
    } catch (e) {
      await shot("FAILED").catch(() => {});
      await dumpPage(page, `${id} failure`).catch(() => {});
      throw e;
    }
  } catch (e) {
    ok = false;
    console.log(`scenario ${id} error: ${e?.stack ?? e}`);
  } finally {
    await rec?.stop().catch(() => {});
    await browser?.close().catch(() => {});
    if (app) {
      printMockFrames(app.mockLog, id);
      await app.stop().catch((e) => console.log(`stop ${id}: ${e.message}`));
      try {
        appendFileSync(process.env.APP_LOG || join(tmp, "app.log"), `\n===== ${id} =====\n${readFileSync(app.appLog, "utf8")}`);
      } catch {}
    }
  }
  console.log("::endgroup::");
  console.log(`RESULT ${id} ${ok ? "ok" : "FAIL"}`);
  results.push([id, ok]);
}

console.log(results.map(([id, ok]) => `${id}=${ok ? "ok" : "FAIL"}`).join(" "));
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
