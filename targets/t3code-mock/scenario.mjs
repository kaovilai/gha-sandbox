// Runs mockkit UI drivers: SCENARIOS=id[,id...] (default s03-markdown-stream) -> mockkit/scenarios-ui/<id>.mjs.
// Each driver: export default async ({ page, shot, env }) => {...}; optional export const meta = { viewport }.
// Files land flat in $OUT_DIR as <id>-<name>.png and <id>.webm (the publish job only globs top level).
import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { run } from "../../lib.mjs";
import { dumpPage, skipOnboarding } from "../../mockkit/lib/ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "../../mockkit/scenarios-ui");
const ids = (process.env.SCENARIOS || "s03-markdown-stream").split(",").map((s) => s.trim()).filter(Boolean);
const out = process.env.OUT_DIR ?? "out";
const results = [];

// The pairing token is ONE-TIME: authenticate once, reuse the session (storageState) for every scenario.
const stateFile = join(process.env.RUNNER_TEMP || "/tmp", "mockkit", "auth-state.json");
mkdirSync(dirname(stateFile), { recursive: true });
{
  const b = await chromium.launch();
  const c = await b.newContext();
  const p = await c.newPage();
  await p.goto(process.env.APP_URL, { waitUntil: "networkidle" });
  await p.waitForTimeout(3000);
  await c.storageState({ path: stateFile });
  process.env.APP_URL = new URL(p.url()).origin + "/";
  console.log(`authenticated; app origin ${new URL(p.url()).origin}`);
  await b.close();
}

for (const id of ids) {
  const file = join(uiDir, `${id}.mjs`);
  if (!existsSync(file)) {
    console.log(`RESULT ${id} FAIL (no driver ${file})`);
    results.push([id, false]);
    continue;
  }
  const mod = await import(pathToFileURL(file).href);
  console.log(`::group::scenario ${id}`);
  let ok = true;
  try {
    await run(
      async ({ page, shot }) => {
        const sshot = (name, opts) => shot(`${id}-${name}`, opts);
        try {
          await mod.default({ page, shot: sshot, env: process.env });
        } catch (e) {
          await sshot("FAILED").catch(() => {});
          await dumpPage(page, `${id} failure`).catch(() => {});
          throw e;
        }
      },
      { viewport: mod.meta?.viewport ?? { width: 1440, height: 900 }, init: skipOnboarding, storageState: stateFile },
    );
  } catch (e) {
    ok = false;
    console.log(`scenario ${id} error: ${e?.stack ?? e}`);
  }
  const rec = join(out, "recording.webm");
  if (existsSync(rec)) renameSync(rec, join(out, `${id}.webm`));
  console.log("::endgroup::");
  console.log(`RESULT ${id} ${ok ? "ok" : "FAIL"}`);
  results.push([id, ok]);
}

// ---- logs into the run log (artifacts only carry png/webm) ----------------------------------------
function tail(path, n, label) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    console.log(`::group::${label} (last ${n} of ${lines.length})\n${lines.slice(-n).join("\n")}\n::endgroup::`);
  } catch (e) {
    console.log(`${label}: unreadable (${e.message})`);
  }
}
if (process.env.MOCK_LOG) {
  try {
    const frames = readFileSync(process.env.MOCK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const brief = frames.map((f) => {
      const fr = f.frame;
      const what = fr ? (fr.method ?? (fr.error ? "error" : "result")) + (fr.params?.update?.sessionUpdate ? `:${fr.params.update.sessionUpdate}` : "") : (f.raw ? f.raw.slice(0, 110) : (f.type ?? f.state ?? f.scenario ?? ""));
      return `${f.seq} ${f.dir} ${what}`;
    });
    console.log(`::group::mock frames (${brief.length}), pids=${[...new Set(frames.map((f) => f.pid))].join(",")}\n${brief.slice(0, 400).join("\n")}\n::endgroup::`);
  } catch (e) {
    console.log(`mock log unreadable: ${e.message}`);
  }
}
if (process.env.MOCKKIT_APP_LOG) tail(process.env.MOCKKIT_APP_LOG, 120, "app log");

console.log(results.map(([id, ok]) => `${id}=${ok ? "ok" : "FAIL"}`).join(" "));
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
