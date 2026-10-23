// Boot one isolated BUILT t3code Electron app (under the caller's Xvfb $DISPLAY) for ONE scenario:
// fresh T3CODE_HOME (DB + settings), fresh XDG_CONFIG_HOME (Chromium profile/localStorage), fresh workspace repo, fresh mock control dir.
// Playwright attaches over CDP (--remote-debugging-port); native bits go through xdotool (lib/native.mjs).
//   const app = await bootDesktop({ id, target })  ->  { cdpUrl, ws, ctl, mockLog, state, appLog, win, root, stop() }
// Zero deps (node built-ins). State dir = $T3CODE_HOME/userdata (apps/desktop/src/app/DesktopStatePaths.ts, non-dev).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findWindow, placeWindow, sleep } from "./native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const harness = resolve(here, "../..");
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
    if (Date.now() - t0 > timeout) throw new Error(`readiness: ${what} not reached within ${Math.round(timeout / 1000)}s${onFail ? `\n${onFail()}` : ""}`);
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

export async function bootDesktop({
  id,
  target = process.env.MOCKKIT_TARGET,
  tmp = process.env.RUNNER_TEMP || "/tmp",
  cdpPort = Number(process.env.DESKTOP_CDP_PORT || 9222),
  size = { w: Number(process.env.DESKTOP_W || 1440), h: Number(process.env.DESKTOP_H || 900) },
}) {
  if (!target || !existsSync(join(target, "apps/desktop/dist-electron"))) {
    throw new Error(`desktop boot: built desktop app not found (MOCKKIT_TARGET=${target}; need apps/desktop/dist-electron, run build:desktop)`);
  }
  const root = join(tmp, "mockkit-desktop", id);
  rmSync(root, { recursive: true, force: true });
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  const ws = join(root, "ws", "demo-app");
  const ctl = join(root, "control");
  const mockLog = join(root, "mock.ndjson");
  const appLog = join(root, "app.log");
  for (const d of [home, xdg, dirname(ws), ctl]) mkdirSync(d, { recursive: true });
  execFileSync("bash", [join(harness, "mockkit/seed/workspace.sh"), ws], { stdio: "inherit" });

  const env = { ...process.env };
  Object.assign(env, {
    T3CODE_HOME: home,
    XDG_CONFIG_HOME: xdg,
    T3CODE_TELEMETRY_ENABLED: "false",
    T3CODE_OTEL_SDK_DISABLED: "true",
    T3CODE_NO_BROWSER: "1",
    T3CODE_DISABLE_AUTO_UPDATE: "true",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    MOCK_LOG: mockLog,
    MOCK_CONTROL_DIR: ctl,
    MOCK_PACE: process.env.MOCK_PACE || "real",
    MOCK_SEED: process.env.MOCK_SEED || "1",
    ELECTRON_ENABLE_LOGGING: "1",
  });
  delete env.VITE_DEV_SERVER_URL; // must be unset: it flips the app into dev mode (DevTools window, state dir "dev")
  delete env.T3CODE_RELAY_URL;
  for (const k of Object.keys(env)) if (/^(T3CODE_CLERK_|VITE_CLERK_)/.test(k)) delete env[k];

  // Seed settings.json (mock provider READY) + client-settings.json (skip onboarding) BEFORE launch.
  const state = join(home, "userdata");
  execFileSync("node", [join(harness, "mockkit/seed/settings.mjs"), state], { env, stdio: "inherit" });

  const fd = openSync(appLog, "a");
  const child = spawn(
    process.execPath,
    [join(harness, "mockkit/bin/desktop-electron.mjs"), target, `--remote-debugging-port=${cdpPort}`, "--password-store=basic"],
    { cwd: target, env, detached: true, stdio: ["ignore", fd, fd] },
  );
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
    // The backend (apps/server/dist/bin.mjs, run via electron-as-node) is spawned in its own process group, so it can outlive
    // a killed main process and keep the backend port (3773) taken: kill stragglers by command line. One app at a time.
    for (const pat of ["apps/server/dist/bin.mjs", `--remote-debugging-port=${cdpPort}`, "node_modules/electron/dist/electron"]) {
      spawnSync("pkill", ["-9", "-f", "--", pat], { stdio: "ignore" });
    }
    await poll("CDP port free", async () => !(await fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(() => true, () => false)), { timeout: 15_000, every: 300 }).catch((e) => console.log(`stop: ${e.message}`));
    await sleep(800);
  };

  try {
    const tailLog = () => `--- app log tail (${appLog}) ---\n${tail(appLog)}${exited ? `\n--- electron ${exited}` : ""}`;
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    let cdpState = "no response yet";
    const head = () => {
      try {
        return readFileSync(appLog, "utf8").split("\n").slice(0, 12).join("\n");
      } catch {
        return "";
      }
    };
    // The renderer page is up once CDP lists a page target on the backend's http(s) origin.
    const pageUrl = await poll(
      "Electron CDP page target (http/https app origin)",
      async () => {
        if (exited) throw new Error(`desktop boot: electron died early (${exited})\n${tailLog()}`);
        try {
          const list = await (await fetch(`${cdpUrl}/json/list`)).json();
          cdpState = `targets: ${list.map((t) => `${t.type}:${t.url.slice(0, 80)}`).join(" | ")}`;
          return list.find((t) => t.type === "page" && /^(https?|t3code):\/\//.test(t.url) && !/devtools/i.test(t.url))?.url ?? null;
        } catch (e) {
          cdpState = `fetch failed: ${e.message}`;
          return null;
        }
      },
      {
        timeout: Number(process.env.DESKTOP_BOOT_TIMEOUT_MS || 120_000),
        every: 1500,
        onFail: () => `cdp ${cdpUrl}: ${cdpState}\n--- app log head ---\n${head()}\n${tailLog()}\n--- listeners ---\n${spawnSync("ss", ["-ltnp"], { encoding: "utf8" }).stdout}`,
      },
    );
    console.log(`desktop ${id}: stateDir=${state} page=${pageUrl.replace(/[?#].*/, "")}`);

    const win = await poll("X11 window '^T3 Code'", () => findWindow("^T3 Code"), { timeout: 60_000, onFail: tailLog });
    placeWindow(win, size.w, size.h);

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
    return { cdpUrl, pageUrl, win, ws, ctl, mockLog, state, appLog, root, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
