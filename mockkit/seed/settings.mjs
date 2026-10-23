#!/usr/bin/env node
// Seed T3 Code provider settings so the mock shows up as a READY provider (no API key).
//   node mockkit/seed/settings.mjs <stateDir> [--home <home>]
// stateDir = dir holding settings.json (discover with `find <home> -name environment-id`).
// Writes: <stateDir>/settings.json (providerInstances merged in, other keys preserved)
//         <stateDir>/client-settings.json {onboardingCompletedAt} (skips the wizard)
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: settings.mjs <stateDir>");
  process.exit(2);
}
const bin = resolve(here, "../bin");
const launcher = join(bin, "mock-cli.sh");
chmodSync(launcher, 0o755);

const env = (extra = {}) =>
  Object.entries({
    MOCK_PACE: process.env.MOCK_PACE ?? "real",
    MOCK_SEED: process.env.MOCK_SEED ?? "1",
    MOCK_LOG: process.env.MOCK_LOG ?? "/tmp/mockkit/mock.ndjson",
    MOCK_CONTROL_DIR: process.env.MOCK_CONTROL_DIR ?? "/tmp/mockkit/control",
    MOCK_NODE: process.execPath,
    ...extra,
  }).map(([name, value]) => ({ name, value }));

// MOCK_PROVIDER = which mock providers are READY: grok (default) | codex | both. The Codex instance uses the same
// launcher with MOCK_CLI_FLAVOR=codex (never setupMode "managed": that would download the real CLI).
const which = (process.env.MOCK_PROVIDER || "grok").toLowerCase();
const useGrok = which !== "codex";
const useCodex = which === "codex" || which === "both";
const providerInstances = {};
providerInstances.grok = useGrok
  ? { driver: "grok", enabled: true, environment: env(), config: { binaryPath: launcher } }
  : { driver: "grok", enabled: false };
if (useCodex) {
  providerInstances.codex = { driver: "codex", enabled: true, environment: env({ MOCK_CLI_FLAVOR: "codex" }), config: { binaryPath: launcher } };
}
// Real providers can never work keyless: disable them so no "Could not start Codex CLI" banner and the
// model picker defaults to the mock. MOCK_KEEP_OTHER_PROVIDERS=1 leaves them as discovered.
if (process.env.MOCK_KEEP_OTHER_PROVIDERS !== "1") {
  if (!useCodex) providerInstances.codex = { driver: "codex", enabled: false };
  providerInstances.claudeAgent = { driver: "claudeAgent", enabled: false };
}

mkdirSync(stateDir, { recursive: true });
const settingsPath = join(stateDir, "settings.json");
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {}
}
settings.providerInstances = { ...(settings.providerInstances ?? {}), ...providerInstances };
// Supervised threads (approvals) for CLI-started threads: they take their mode from the environment default.
if (process.env.MOCK_DEFAULT_RUNTIME_MODE) settings.defaultRuntimeMode = process.env.MOCK_DEFAULT_RUNTIME_MODE;
// Titles / commit messages / PR text go through the same mock (it answers JSON without running scenarios).
settings.textGenerationModelSelection = which === "codex" ? { instanceId: "codex", model: "gpt-6-luna" } : { instanceId: "grok", model: "grok-build" };
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
writeFileSync(join(stateDir, "client-settings.json"), `${JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z" })}\n`);
console.log(`seeded ${settingsPath} (instances: ${Object.keys(settings.providerInstances).join(",")})`);
