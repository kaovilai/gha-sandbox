// node --test mockkit/test : runner hostname / absolute path masking rules (pure string side; the in-page script uses the same rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMask, buildMaskRules, MASK_HOME, MASK_HOST } from "../lib/mask.mjs";

const ws = "/home/runner/work/_temp/mockkit-run/s37-files-browser/ws/demo-app";
const root = "/home/runner/work/_temp/mockkit-run/s37-files-browser";
const rules = buildMaskRules({ ws, root, tmp: "/home/runner/work/_temp", hostname: "runnervm8k3b6", home: "/home/runner" });

test("workspace path becomes a neutral project path", () => {
  assert.equal(applyMask(`Wrote ${ws}/NOTES.md`, rules), `Wrote ${MASK_HOME}/demo-app/NOTES.md`);
});

test("the mock run root and its siblings are masked too", () => {
  assert.equal(applyMask(`${root}/control/probes.log`, rules), `${MASK_HOME}/.sandbox/control/probes.log`);
  assert.equal(applyMask("/home/runner/work/_temp/other", rules), "/tmp/other");
  assert.equal(applyMask("/home/runner/.cache/x", rules), `${MASK_HOME}/.cache/x`);
});

test("runner hostname is masked, case-insensitive, also for a different runnervm id", () => {
  assert.equal(applyMask("runnervm8k3b6", rules), MASK_HOST);
  assert.equal(applyMask("RUNNERVMabc12 / main", rules), `${MASK_HOST} / main`);
});

test("ordinary text and relative paths are untouched", () => {
  const s = "src/greeting.ts changed, http://localhost:5733/ ok";
  assert.equal(applyMask(s, rules), s);
});

test("no rule can leave its own match behind (idempotent)", () => {
  const once = applyMask(`${ws}/a runnervm8k3b6 /home/runner/x`, rules);
  assert.equal(applyMask(once, rules), once);
  for (const [src, flags] of rules) assert.equal(new RegExp(src, flags).test(once), false, `rule ${src} matches masked output`);
});

test("localhost-like or tiny hostnames never produce a catch-all rule", () => {
  const r = buildMaskRules({ ws, hostname: "localhost", home: "/", tmp: "/tmp" });
  assert.equal(applyMask("localhost:5733 and ab", r), "localhost:5733 and ab");
});
