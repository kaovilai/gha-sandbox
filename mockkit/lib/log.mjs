// Structured NDJSON frame log. Path from $MOCK_LOG (unset = silent).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function makeLog(path = process.env.MOCK_LOG, base = {}) {
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {}
  }
  let seq = 0;
  return function log(dir, data = {}) {
    if (!path) return;
    const rec = { t: new Date().toISOString(), seq: ++seq, pid: process.pid, dir, ...base, ...data };
    try {
      appendFileSync(path, `${JSON.stringify(rec)}\n`);
    } catch {}
  };
}
