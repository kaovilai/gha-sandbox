// Runs mockkit UI drivers, ONE ISOLATED T3 Code instance per scenario (fresh DB + workspace + control dir).
//   SCENARIOS = comma list of driver ids ("s07-shell-command-output"), short prefixes ("s07"), or pack names
//   from mockkit/packs.json ("web", "smoke", "all", ...). Default: s03-markdown-stream.
// Each driver: export default async ({ page, shot, env }) => {...}; optional export const meta = { viewport }.
// Files land flat in $OUT_DIR as <id>-<name>.png and <id>.webm (the publish job only globs top level).
import { existsSync, readdirSync, readFileSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { run } from "../../lib.mjs";
import { bootT3 } from "../../mockkit/lib/boot.mjs";
import { buildMaskRules, installMaskContext, maskNow } from "../../mockkit/lib/mask.mjs";
import { assertShell, dumpPage, skipOnboarding } from "../../mockkit/lib/ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, "../../mockkit/scenarios-ui");
const out = process.env.OUT_DIR ?? "out";
const tmp = process.env.RUNNER_TEMP || "/tmp";

// ---- resolve SCENARIOS (ids | prefixes | packs) ----------------------------------------------------
const drivers = readdirSync(uiDir).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort();
const packs = JSON.parse(readFileSync(join(here, "../../mockkit/packs.json"), "utf8"));
// Provider per scenario: token suffix "@codex" / "@grok" (s03@codex), pack name starting with "codex" (packs.json "codex"),
// or env MOCK_PROVIDER=codex|grok for everything; default grok. A driver may export
// `meta.seed = { codex: "both" }` to seed more providers than it runs against (e.g. the model-picker driver).
// Claude flavor: "@claude" suffix (s03@claude), pack name starting with "claude" (packs.json "claude"), or MOCK_PROVIDER=claude; runs are named "claude-<driver>".
const labelOf = (e) => (e.prov === "codex" ? `codex-${e.id}` : e.prov === "claude" ? `claude-${e.id}` : e.id);
function resolveIds(spec) {
  const out = new Map();
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [tok, atProv] = raw.split("@");
    const prov = atProv || (/^codex/.test(tok) ? "codex" : /^claude/.test(tok) ? "claude" : process.env.MOCK_PROVIDER === "codex" ? "codex" : process.env.MOCK_PROVIDER === "claude" ? "claude" : "grok");
    const list = packs[tok] ? (packs[tok] === "*" ? drivers : packs[tok]) : [tok];
    for (const t of list) {
      const hit = drivers.includes(t) ? [t] : drivers.filter((d) => d.startsWith(`${t}-`));
      const e = { id: hit.length === 1 ? hit[0] : t, prov }; // unknown/ambiguous: reported as FAIL below
      out.set(labelOf(e), e);
    }
  }
  return [...out.values()];
}
const spec = (process.env.SCENARIOS || "").trim() || "s03-markdown-stream";
const ids = resolveIds(spec);
console.log(`scenarios (${spec}): ${ids.map(labelOf).join(" ")}`);

mkdirSync(out, { recursive: true });
const results = [];

// ---- authenticate once per server (the pairing token is ONE-TIME) -> storageState + app origin -------
async function authenticate(srv, id, firstRun = false) {
  const stateFile = join(srv.root, "auth-state.json");
  const b = await chromium.launch();
  try {
    const c = await b.newContext();
    if (!firstRun) await skipOnboarding(c);
    const p = await c.newPage();
    await p.goto(srv.url, { waitUntil: "networkidle" });
    // first-run drivers (meta.firstRun) land on the setup wizard, not the app shell
    if (firstRun) await p.waitForTimeout(4000);
    else await assertShell(p, `authenticated shell (${id})`, 60_000);
    const text = await p.evaluate(() => document.body.innerText);
    if (/invalid.*(token|pairing)|pairing.*(invalid|expired)/i.test(text)) throw new Error(`auth: pairing rejected: ${text.slice(0, 200)}`);
    await c.storageState({ path: stateFile });
    const origin = new URL(p.url()).origin;
    console.log(`authenticated; app origin ${origin}`);
    return { stateFile, origin };
  } catch (e) {
    throw new Error(`auth failed for ${id}: ${e.message}`);
  } finally {
    await b.close();
  }
}

function printMockFrames(mockLog, id) {
  try {
    const frames = readFileSync(mockLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const brief = frames.map((f) => {
      const fr = f.frame;
      const what = fr ? (fr.method ?? (fr.error ? "error" : "result")) + (fr.params?.update?.sessionUpdate ? `:${fr.params.update.sessionUpdate}` : "") + (fr.params?.item?.type ? `:${fr.params.item.type}` : "") : f.raw ? f.raw.slice(0, 110) : (f.type ?? f.state ?? f.scenario ?? "");
      return `${f.seq} ${f.dir} ${what}${f.queued ? " (queued)" : ""}`;
    });
    const prompts = frames.filter((f) => f.dir === "prompt").map((f) => `turn=${f.turn} scenario=${f.scenario} tag=${f.tag} queued=${f.queued}`);
    console.log(`::group::mock frames ${id} (${brief.length}), pids=${[...new Set(frames.map((f) => f.pid))].join(",")}\nprompts: ${prompts.join(" | ")}\n${brief.slice(0, 200).join("\n")}\n::endgroup::`);
  } catch (e) {
    console.log(`mock log ${id} unreadable: ${e.message}`);
  }
}

for (const entry of ids) {
  const id = labelOf(entry); // evidence file prefix ("codex-<driver>" for Codex runs)
  const file = join(uiDir, `${entry.id}.mjs`);
  if (!existsSync(file)) {
    console.log(`RESULT ${id} FAIL (no driver ${file}; known: ${drivers.join(", ")}; packs: ${Object.keys(packs).join(", ")})`);
    results.push([id, false]);
    continue;
  }
  const mod = await import(pathToFileURL(file).href);
  console.log(`::group::scenario ${id} (provider ${entry.prov})`);
  let ok = true;
  let srv;
  try {
    // seed (settings.mjs) reads MOCK_PROVIDER: which mock providers are READY; the driver runs against entry.prov
    process.env.MOCK_PROVIDER = mod.meta?.seed?.[entry.prov] ?? entry.prov;
    srv = await bootT3({ id });
    const { stateFile, origin } = await authenticate(srv, id, mod.meta?.firstRun === true);
    process.env.APP_URL = `${origin}/`;
    const env = { ...process.env, MOCKKIT_PROVIDER: entry.prov, MOCKKIT_WS: srv.ws, MOCKKIT_STATE: srv.state, MOCKKIT_ROOT: srv.root, MOCK_CONTROL_DIR: srv.ctl, MOCK_LOG: srv.mockLog };
    // runner hostname + absolute runner/workspace paths are masked in the DOM (screenshots AND video), see mockkit/lib/mask.mjs
    const maskRules = buildMaskRules({ ws: srv.ws, root: srv.root });
    await run(
      async ({ page, shot }) => {
        const sshot = (name, opts) => shot(`${id}-${name}`, opts);
        try {
          await mod.default({ page, shot: sshot, env });
        } catch (e) {
          await sshot("FAILED").catch(() => {});
          await dumpPage(page, `${id} failure`).catch(() => {});
          throw e;
        }
      },
      {
        viewport: mod.meta?.viewport ?? { width: 1440, height: 900 },
        init: async (context) => {
          if (!mod.meta?.firstRun) await skipOnboarding(context);
          await installMaskContext(context, maskRules);
        },
        beforeShot: (page) => maskNow(page, maskRules),
        storageState: stateFile,
      },
    );
  } catch (e) {
    ok = false;
    console.log(`scenario ${id} error: ${e?.stack ?? e}`);
  } finally {
    if (srv) {
      printMockFrames(srv.mockLog, id);
      await srv.stop().catch((e) => console.log(`stop ${id}: ${e.message}`));
      try {
        appendFileSync(process.env.APP_LOG || join(tmp, "app.log"), `\n===== ${id} =====\n${readFileSync(srv.appLog, "utf8")}`);
      } catch {}
    }
  }
  const rec = join(out, "recording.webm");
  if (existsSync(rec)) renameSync(rec, join(out, `${id}.webm`));
  console.log("::endgroup::");
  console.log(`RESULT ${id} ${ok ? "ok" : "FAIL"}`);
  results.push([id, ok]);
}

console.log(results.map(([id, ok]) => `${id}=${ok ? "ok" : "FAIL"}`).join(" "));
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
