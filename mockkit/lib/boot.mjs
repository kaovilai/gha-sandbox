// Boot one isolated T3 Code (web dev) instance for ONE scenario: fresh home dir (DB, settings), fresh workspace repo,
// fresh mock control dir + log, no cwd auto-bootstrap project/thread. Tear it down with stop().
//   const srv = await bootT3({ id, target })  ->  { url (pairing), ws, ctl, mockLog, state, appLog, stop() }
// Used by targets/t3code-mock/scenario.mjs. Zero deps (node built-ins).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harness = resolve(here, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (file, n = 60) => {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-n).join("\n");
  } catch {
    return "(log unreadable)";
  }
};

async function poll(what, fn, { timeout, every = 1000, onFail }) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) {
      throw new Error(`readiness: ${what} not reached within ${Math.round(timeout / 1000)}s${onFail ? `\n${onFail()}` : ""}`);
    }
    await sleep(every);
  }
}

const groupAlive = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function bootT3({ id, target = process.env.MOCKKIT_TARGET, tmp = process.env.RUNNER_TEMP || "/tmp" }) {
  if (!target || !existsSync(target)) throw new Error(`boot: target checkout not found (MOCKKIT_TARGET=${target})`);
  const root = join(tmp, "mockkit-run", id);
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const ws = join(root, "ws", "demo-app"); // project name in the sidebar = basename
  const ctl = join(root, "control");
  const mockLog = join(root, "mock.ndjson");
  const appLog = join(root, "app.log");
  for (const d of [home, dirname(ws), ctl]) mkdirSync(d, { recursive: true });

  execFileSync("bash", [join(harness, "mockkit/seed/workspace.sh"), ws], { stdio: "inherit" });

  const env = { ...process.env };
  Object.assign(env, {
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    T3CODE_NO_BROWSER: "1",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    // No project/thread from the server cwd: the sidebar starts empty, each scenario adds only its own workspace.
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    MOCK_LOG: mockLog,
    MOCK_CONTROL_DIR: ctl,
    MOCK_PACE: process.env.MOCK_PACE || "real",
    MOCK_SEED: process.env.MOCK_SEED || "1",
  });
  delete env.T3CODE_RELAY_URL;
  for (const k of Object.keys(env)) if (/^(T3CODE_CLERK_|VITE_CLERK_)/.test(k)) delete env[k];

  // Pre-seed settings (provider READY on first probe, no hot-reload wait). Re-seeded below if the state dir differs.
  const seed = (dir) => execFileSync("node", [join(harness, "mockkit/seed/settings.mjs"), dir], { env, stdio: "inherit" });
  seed(join(home, "userdata"));

  const fd = openSync(appLog, "a");
  const child = spawn("xvfb-run", ["-a", "vp", "run", "dev", "--home-dir", home], { cwd: target, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let exited = null;
  child.on("exit", (code, sig) => (exited = `exit code=${code} signal=${sig}`));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 40 && groupAlive(child.pid); i++) await sleep(250);
    if (groupAlive(child.pid)) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    // stragglers that left the group (vite / node --watch children keep the --home-dir argument)
    spawnSync("pkill", ["-f", "--", `--home-dir ${home}`], { stdio: "ignore" });
    await sleep(500);
  };

  try {
    const tailLog = () => `--- app log tail (${appLog}) ---\n${tail(appLog)}${exited ? `\n--- dev server ${exited}` : ""}`;
    const url = await poll(
      "pairingUrl in dev server log",
      () => {
        if (exited) throw new Error(`boot: dev server died early (${exited})\n${tailLog()}`);
        const m = readFileSync(appLog, "utf8").match(/pairingUrl: *(\S+)/);
        return m?.[1] ?? null;
      },
      { timeout: 240_000, every: 1500, onFail: tailLog },
    );

    // state dir = dir holding environment-id (HOME/userdata under `vp run dev --home-dir`)
    const state = await poll(
      "environment-id (state dir)",
      () => {
        const out = spawnSync("find", [home, "-name", "environment-id"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
        return out ? dirname(out) : null;
      },
      { timeout: 60_000, onFail: tailLog },
    );
    console.log(`boot ${id}: stateDir=${state}`);
    if (state !== join(home, "userdata")) seed(state);

    // provider readiness: T3 must have probed the mock CLI (`grok models`); the UI side then waits for the model picker.
    await poll(
      "T3 probed the mock provider (probes.log has `models`)",
      () => {
        try {
          return /\smodels\b/.test(readFileSync(join(ctl, "probes.log"), "utf8"));
        } catch {
          return false;
        }
      },
      { timeout: 120_000, onFail: () => `probes.log: ${tail(join(ctl, "probes.log"), 20)}\n${tailLog()}` },
    );

    return { url, ws, ctl, mockLog, state, appLog, root, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
