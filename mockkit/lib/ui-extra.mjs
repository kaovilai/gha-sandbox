// Extra Playwright / seeding helpers for the wider scenario set (kept apart from lib/ui.mjs).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpPage } from "./ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER = resolve(here, "../bin/mock-cli.sh");

// Merge extra grok-driver provider instances into the running server's settings.json (hot-reloaded by T3).
//   instances: { <instanceId>: { displayName, mode?: ready|unauth|old|broken|missing, binaryPath?, enabled?, accentColor? } }
export function seedInstances(env, instances) {
  const file = join(env.MOCKKIT_STATE, "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  chmodSync(LAUNCHER, 0o755);
  const base = {
    MOCK_PACE: env.MOCK_PACE ?? "real",
    MOCK_SEED: env.MOCK_SEED ?? "1",
    MOCK_LOG: env.MOCK_LOG,
    MOCK_CONTROL_DIR: env.MOCK_CONTROL_DIR,
    MOCK_NODE: process.execPath,
  };
  settings.providerInstances = settings.providerInstances ?? {};
  for (const [id, o] of Object.entries(instances)) {
    settings.providerInstances[id] = {
      driver: "grok",
      ...(o.displayName ? { displayName: o.displayName } : {}),
      ...(o.accentColor ? { accentColor: o.accentColor } : {}),
      enabled: o.enabled ?? true,
      environment: Object.entries({ ...base, MOCK_CLI_MODE: o.mode ?? "ready" }).map(([name, value]) => ({ name, value })),
      config: { binaryPath: o.binaryPath ?? LAUNCHER },
    };
  }
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`seeded extra instances into ${file}: ${Object.keys(instances).join(",")}`);
}

// Add an acpRegistry (local command) instance running upstream apps/server/scripts/acp-mock-agent.ts from the target checkout
// (needs its node_modules; run with --experimental-strip-types). `flags` = T3_ACP_* env vars, e.g. { T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG: "1" }.
export function seedUpstreamAcp(env, id, displayName, flags = {}) {
  const file = join(env.MOCKKIT_STATE, "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const agent = join(process.env.MOCKKIT_TARGET, "apps/server/scripts/acp-mock-agent.ts");
  if (!existsSync(agent)) throw new Error(`upstream mock agent missing: ${agent}`);
  settings.providerInstances = settings.providerInstances ?? {};
  settings.providerInstances[id] = {
    driver: "acpRegistry",
    displayName,
    enabled: true,
    environment: Object.entries(flags).map(([name, value]) => ({ name, value: String(value) })),
    config: { source: "local", commandPath: process.execPath, commandArgs: ["--experimental-strip-types", "--no-warnings", agent] },
  };
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`seeded upstream acp instance ${id} (${displayName}) -> ${agent}; node ${process.version}`);
}

export const gotoPath =async (page, path) => {
  await page.goto(new URL(path, page.url()).href, { waitUntil: "load" });
  await page.waitForTimeout(1500);
};

// Wait for a locator, dumping the page (so the CI log shows the real DOM) before rethrowing.
export async function must(page, loc, what, timeout = 20_000) {
  try {
    await loc.first().waitFor({ state: "visible", timeout });
  } catch {
    await dumpPage(page, `missing: ${what}`);
    throw new Error(`expected UI element not found: ${what}`);
  }
  return loc.first();
}
