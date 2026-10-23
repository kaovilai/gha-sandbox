import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { labelOf, resolveScenarios } from "../lib/resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drivers = ["dk01-window-chrome", "s03-markdown-stream", "s08-approval-allow"];
const packs = { desktop: ["s03-markdown-stream", "dk01-window-chrome"], "desktop-codex": ["s03-markdown-stream", "dk01-window-chrome"], codex: ["s03-markdown-stream"] };
const labels = (spec, envProv) => resolveScenarios(spec, { packs, found: new Map(drivers.map((d) => [d, d])), drivers, envProv }).map(labelOf);

test("default flavor is grok, ids unprefixed", () => {
  assert.deepEqual(labels("desktop"), ["s03-markdown-stream", "dk01-window-chrome"]);
});
test("env codex flips every token; labels get codex- prefix", () => {
  assert.deepEqual(labels("desktop", "codex"), ["codex-s03-markdown-stream", "codex-dk01-window-chrome"]);
});
test("env both runs each driver twice, grok first", () => {
  assert.deepEqual(labels("s03", "both"), ["s03-markdown-stream", "codex-s03-markdown-stream"]);
});
test("codex-named packs and @codex suffix force codex regardless of env", () => {
  assert.deepEqual(labels("desktop-codex", "grok"), ["codex-s03-markdown-stream", "codex-dk01-window-chrome"]);
  assert.deepEqual(labels("s08@codex,dk01@grok", "grok"), ["codex-s08-approval-allow", "dk01-window-chrome"]);
});
test("unknown token is kept verbatim for FAIL reporting", () => {
  assert.deepEqual(labels("nope", "codex"), ["codex-nope"]);
});

function seed(provider) {
  const dir = mkdtempSync(join(tmpdir(), "seed-"));
  const r = spawnSync(process.execPath, [join(here, "../seed/settings.mjs"), dir], { env: { ...process.env, MOCK_PROVIDER: provider, MOCK_CONTROL_DIR: join(dir, "ctl") }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
}
test("seed: MOCK_PROVIDER=codex enables codex (flavor env), disables grok, text-gen on codex", () => {
  const s = seed("codex");
  assert.equal(s.providerInstances.codex.enabled, true);
  assert.equal(s.providerInstances.grok.enabled, false);
  assert.ok(s.providerInstances.codex.environment.some((e) => e.name === "MOCK_CLI_FLAVOR" && e.value === "codex"));
  assert.equal(s.textGenerationModelSelection.instanceId, "codex");
});
test("seed: grok default keeps codex disabled; both enables both", () => {
  const g = seed("grok");
  assert.equal(g.providerInstances.grok.enabled, true);
  assert.equal(g.providerInstances.codex.enabled, false);
  const b = seed("both");
  assert.equal(b.providerInstances.grok.enabled, true);
  assert.equal(b.providerInstances.codex.enabled, true);
});
