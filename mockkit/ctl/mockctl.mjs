#!/usr/bin/env node
// Control helper for scenario drivers and shells.
//   mockctl.mjs next <scenario-id> [k=v ...] [--cwd <dir>]   hidden routing: next user turn (in that cwd) runs <id>
//   mockctl.mjs release <name>        let a {hold:<name>} step continue
//   mockctl.mjs wait-reached <name> [timeoutMs]
//   mockctl.mjs reset                 clear all gates + queue
// Also importable: import { release, waitReached, next } from "mockkit/ctl/mockctl.mjs"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlDir, safeName } from "../lib/hold.mjs";
import { enqueue } from "../lib/queue.mjs";

export function next(id, args = {}, { cwd, env = process.env } = {}) {
  enqueue(id, args, { cwd, env });
}

export function release(name, env = process.env) {
  const d = join(controlDir(env), "release");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, safeName(name)), String(Date.now()));
}

export async function waitReached(name, timeoutMs = 60_000, env = process.env) {
  const f = join(controlDir(env), "reached", safeName(name));
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
  const [cmd, name, ...rest] = process.argv.slice(2);
  if (cmd === "release") release(name);
  else if (cmd === "wait-reached") await waitReached(name, rest[0] ? Number(rest[0]) : undefined);
  else if (cmd === "reset") reset();
  else if (cmd === "next") {
    const args = {};
    let cwd;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--cwd") cwd = rest[++i];
      else {
        const eq = rest[i].indexOf("=");
        if (eq > 0) args[rest[i].slice(0, eq)] = rest[i].slice(eq + 1);
        else args[rest[i]] = "1";
      }
    }
    next(name, args, { cwd });
  } else {
    console.error("usage: mockctl.mjs next|release|wait-reached|reset <name>");
    process.exit(2);
  }
}
