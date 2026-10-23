#!/usr/bin/env node
// Control helper for scenario drivers and shells.
//   mockctl.mjs release <name>        let a {hold:<name>} step continue
//   mockctl.mjs wait-reached <name> [timeoutMs]
//   mockctl.mjs reset                 clear all gates
// Also importable: import { release, waitReached } from "mockkit/ctl/mockctl.mjs"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlDir } from "../lib/hold.mjs";

export function release(name, env = process.env) {
  const d = join(controlDir(env), "release");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), String(Date.now()));
}

export async function waitReached(name, timeoutMs = 60_000, env = process.env) {
  const f = join(controlDir(env), "reached", name);
  const t0 = Date.now();
  while (!existsSync(f)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`hold "${name}" not reached within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function reset(env = process.env) {
  rmSync(controlDir(env), { recursive: true, force: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, name, t] = process.argv.slice(2);
  if (cmd === "release") release(name);
  else if (cmd === "wait-reached") await waitReached(name, t ? Number(t) : undefined);
  else if (cmd === "reset") reset();
  else {
    console.error("usage: mockctl.mjs release|wait-reached|reset <name>");
    process.exit(2);
  }
}
