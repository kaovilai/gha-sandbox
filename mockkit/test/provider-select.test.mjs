import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { expandProviders, labelOf, resolveScenarios } from "../lib/resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drivers = ["dk01-window-chrome", "s03-markdown-stream", "s08-approval-allow"];
const packs = { desktop: ["s03-markdown-stream", "dk01-window-chrome"], "desktop-codex": ["s03-markdown-stream", "dk01-window-chrome"], "desktop-claude": ["s03-markdown-stream", "dk01-window-chrome"], codex: ["s03-markdown-stream"] };
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

test("env claude flips every token; labels get claude- prefix", () => {
  assert.deepEqual(labels("desktop", "claude"), ["claude-s03-markdown-stream", "claude-dk01-window-chrome"]);
});
test("env all runs each driver three times: grok, codex, claude", () => {
  assert.deepEqual(labels("s03", "all"), ["s03-markdown-stream", "codex-s03-markdown-stream", "claude-s03-markdown-stream"]);
});
test("claude-named packs and @claude suffix force claude regardless of env", () => {
  assert.deepEqual(labels("desktop-claude", "grok"), ["claude-s03-markdown-stream", "claude-dk01-window-chrome"]);
  assert.deepEqual(labels("s08@claude,dk01@grok", "codex"), ["claude-s08-approval-allow", "dk01-window-chrome"]);
});
test("expandProviders: lists, both, all, unknown falls back to grok", () => {
  assert.deepEqual(expandProviders("claude+grok"), ["claude", "grok"]);
  assert.deepEqual(expandProviders("both"), ["grok", "codex"]);
  assert.deepEqual(expandProviders("ALL"), ["grok", "codex", "claude"]);
  assert.deepEqual(expandProviders("nonsense"), ["grok"]);
  assert.deepEqual(expandProviders(undefined), ["grok"]);
});
test("packs.json: desktop-claude mirrors the desktop pack", () => {
  const real = JSON.parse(readFileSync(join(here, "../packs.json"), "utf8"));
  assert.deepEqual(real["desktop-claude"], real.desktop);
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
test("seed: MOCK_PROVIDER=claude enables claudeAgent (flavor env), disables grok+codex, text-gen on claudeAgent", () => {
  const s = seed("claude");
  assert.equal(s.providerInstances.claudeAgent.enabled, true);
  assert.equal(s.providerInstances.grok.enabled, false);
  assert.equal(s.providerInstances.codex.enabled, false);
  assert.ok(s.providerInstances.claudeAgent.environment.some((e) => e.name === "MOCK_CLI_FLAVOR" && e.value === "claude"));
  assert.equal(s.textGenerationModelSelection.instanceId, "claudeAgent");
});
test("seed: MOCK_PROVIDER=all enables grok, codex and claudeAgent", () => {
  const s = seed("all");
  for (const k of ["grok", "codex", "claudeAgent"]) assert.equal(s.providerInstances[k].enabled, true, k);
  assert.equal(s.textGenerationModelSelection.instanceId, "grok");
});
