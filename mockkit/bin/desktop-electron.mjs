#!/usr/bin/env node
// Launch the BUILT t3code Electron app with extra Chromium flags (start-electron.mjs cannot pass any through).
//   node desktop-electron.mjs <target-checkout> [electron flags...]
// Mirrors apps/desktop/scripts/start-electron.mjs: build-browser-secret, then electron dist-electron/main.cjs.
// Zero deps. Runs inside the target's apps/desktop dir; imports the target's own launcher helper.
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const target = resolve(process.argv[2] ?? "");
const flags = process.argv.slice(3);
const desktopDir = join(target, "apps/desktop");
execFileSync(process.execPath, [join(desktopDir, "scripts/build-browser-secret.mjs")], { stdio: "inherit" });
const { resolveElectronLaunchCommand } = await import(pathToFileURL(join(desktopDir, "scripts/electron-launcher.mjs")).href);
const cmd = resolveElectronLaunchCommand([...flags, "dist-electron/main.cjs"]) /* flags BEFORE the script, as dev-electron.mjs does */;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`desktop-electron: MOCK_PROVIDER=${env.MOCK_PROVIDER ?? "grok"} MOCK_CLI_FLAVOR=${env.MOCK_CLI_FLAVOR ?? "-"}`);
console.log(`desktop-electron: ${cmd.electronPath} ${cmd.args.join(" ")}`);
const child = spawn(cmd.electronPath, cmd.args, { stdio: "inherit", cwd: desktopDir, env });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => child.kill(s));
