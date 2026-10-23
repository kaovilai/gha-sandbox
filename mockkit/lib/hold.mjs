// Sentinel-file gates so an external driver (Playwright script, shell) can pause/release a scenario.
//   step {hold:"name"}  -> touches $CTL/reached/<name>, blocks until $CTL/release/<name> exists.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { abortError } from "./pace.mjs";

export const safeName = (n) => String(n).replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");

export function controlDir(env = process.env) {
  return env.MOCK_CONTROL_DIR || join(env.TMPDIR || "/tmp", "mockkit-control");
}

export async function hold(rawName, { env = process.env, signal, log } = {}) {
  const name = safeName(rawName);
  const dir = controlDir(env);
  mkdirSync(join(dir, "reached"), { recursive: true });
  mkdirSync(join(dir, "release"), { recursive: true });
  writeFileSync(join(dir, "reached", name), String(Date.now()));
  log?.("hold", { name, state: "reached" });
  const timeout = Number(env.MOCK_HOLD_TIMEOUT_MS ?? 120_000);
  const start = Date.now();
  while (!existsSync(join(dir, "release", name))) {
    if (signal?.aborted) throw abortError();
    if (Date.now() - start > timeout) {
      log?.("hold", { name, state: "timeout" });
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  log?.("hold", { name, state: "released" });
}
