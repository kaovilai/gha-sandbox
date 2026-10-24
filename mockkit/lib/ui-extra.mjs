// Extra Playwright / seeding helpers for the wider scenario set (kept apart from lib/ui.mjs).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { dumpPage } from "./ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER = resolve(here, "../bin/mock-cli.sh");

// Merge extra grok-driver provider instances into the running server's settings.json (hot-reloaded by T3).
//   instances: { <instanceId>: { displayName, driver?: "grok"(default)|"codex", mode?: ready|unauth|old|broken|missing, binaryPath?, enabled?, accentColor? } }
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
      driver: o.driver ?? "grok",
      ...(o.displayName ? { displayName: o.displayName } : {}),
      ...(o.accentColor ? { accentColor: o.accentColor } : {}),
      enabled: o.enabled ?? true,
      environment: Object.entries({ ...base, MOCK_CLI_MODE: o.mode ?? "ready", ...(o.driver === "codex" ? { MOCK_CLI_FLAVOR: "codex" } : o.driver === "claudeAgent" ? { MOCK_CLI_FLAVOR: "claude" } : {}), ...(o.env ?? {}) }).map(([name, value]) => ({ name, value: String(value) })),
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

// Grok-driver instance whose agent is the UPSTREAM acp-mock-agent.ts (via mock-cli.sh MOCK_UPSTREAM_AGENT) with T3_ACP_* flags.
// Unlike the acpRegistry flavor, the grok driver understands the xAI extension frames (rate limit, background tasks, ...).
export function seedUpstreamGrok(env, id, displayName, flags = {}) {
  const agent = join(process.env.MOCKKIT_TARGET, "apps/server/scripts/acp-mock-agent.ts");
  if (!existsSync(agent)) throw new Error(`upstream mock agent missing: ${agent}`);
  seedInstances(env, { [id]: { displayName, env: { MOCK_UPSTREAM_AGENT: agent, ...flags } } });
}

// Open the model picker (Ctrl+Shift+M), choose provider instance <displayName> and its first model.
export async function pickInstance(page, displayName, { shot, model = "Mock Build" } = {}) {
  await page.keyboard.press("Control+Shift+M");
  await page.waitForTimeout(1200);
  const btn = page.getByRole("button", { name: displayName }).first();
  await must(page, btn, `provider ${displayName} in model picker`, 30_000);
  await btn.click();
  await page.waitForTimeout(900);
  await shot?.("picker-instance");
  await page.getByText(model, { exact: true }).last().click(); // popup is portaled last; first() would be the composer trigger label
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
}

export const gotoPath = async (page, path) => {
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

// ---- Claude-gaps helpers -----------------------------------------------------------------------------------------------
// Solid-colour PNG (valid zlib + CRC) so image drivers need no binary fixtures.
export function makePng(width = 64, height = 48, [r, g, b] = [34, 139, 230]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Check that does not fail the driver: prints `FINDING <label>: <value>` (what T3 does / does not render is recorded, not assumed).
export async function finding(label, fn) {
  let v;
  try {
    v = await fn();
  } catch (e) {
    v = `error: ${String(e?.message ?? e).split("\n")[0]}`;
  }
  console.log(`FINDING ${label}: ${v}`);
  return v;
}
