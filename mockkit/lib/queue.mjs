// Hidden scenario routing: drivers enqueue "next scenario" for a workspace (session cwd) in the control dir, so the
// user-visible prompt stays natural (no "[mock:...]" text in the recorded UI). The agent pops one entry per user turn.
//   $MOCK_CONTROL_DIR/queue/<key>.ndjson   key = sha1(realpath(cwd))[0..12], or "_any" (any session)
// An explicit "[mock:<id>]" tag in the prompt still wins and does not consume the queue (unit tests, manual use).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { controlDir } from "./hold.mjs";

export function cwdKey(cwd) {
  if (!cwd) return "_any";
  let p = cwd;
  try {
    p = realpathSync(cwd);
  } catch {}
  return createHash("sha1").update(p).digest("hex").slice(0, 12);
}

const queueFile = (env, key) => join(controlDir(env), "queue", `${key}.ndjson`);

// Append { id, args } for sessions whose cwd is `cwd` (omit cwd = any session).
export function enqueue(id, args = {}, { cwd, env = process.env } = {}) {
  const f = queueFile(env, cwdKey(cwd));
  mkdirSync(join(controlDir(env), "queue"), { recursive: true });
  appendFileSync(f, `${JSON.stringify({ id, args })}\n`);
}

// Pop the oldest entry for this cwd, else for "_any". Returns { id, args } | null.
export function dequeue(cwd, env = process.env) {
  for (const key of [cwdKey(cwd), "_any"]) {
    const f = queueFile(env, key);
    if (!existsSync(f)) continue;
    // claim atomically so two agent processes never take the same entry
    const claim = `${f}.${process.pid}`;
    try {
      renameSync(f, claim);
    } catch {
      continue;
    }
    const lines = readFileSync(claim, "utf8").split("\n").filter(Boolean);
    rmSync(claim, { force: true });
    if (lines.length === 0) continue;
    const [head, ...rest] = lines;
    if (rest.length) {
      // put the remainder back, ahead of anything enqueued meanwhile
      const cur = existsSync(f) ? readFileSync(f, "utf8") : "";
      writeFileSync(f, `${rest.join("\n")}\n${cur}`);
    }
    try {
      const e = JSON.parse(head);
      return { id: String(e.id).toLowerCase(), args: e.args ?? {} };
    } catch {
      return null;
    }
  }
  return null;
}
