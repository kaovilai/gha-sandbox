// S18 provider status matrix: extra grok-driver instances whose launcher reports ready / signed-out / too-old / broken / missing,
// shown as Settings > Providers cards (and the composer picker).
import { dumpPage, providerOf, startSession } from "../lib/ui.mjs";
import { gotoPath, must, seedInstances } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  const codex = providerOf(env) === "codex";
  const claude = providerOf(env) === "claude";
  // Codex flavor: the default `codex` instance is READY (apiKey account); extra codex-driver instances show signed out / outdated / broken / missing.
  // Claude flavor: same matrix with claudeAgent-driver instances (default `claudeAgent` READY, "Claude Max" account).
  seedInstances(
    env,
    claude
      ? {
          claude_unauth: { driver: "claudeAgent", displayName: "Claude (signed out)", mode: "unauth" },
          claude_old: { driver: "claudeAgent", displayName: "Claude (outdated)", mode: "old" },
          claude_broken: { driver: "claudeAgent", displayName: "Claude (broken CLI)", mode: "broken" },
          claude_nobin: { driver: "claudeAgent", displayName: "Claude (binary missing)", binaryPath: "/nonexistent/path/to/claude" },
        }
      : codex
      ? {
          codex_unauth: { driver: "codex", displayName: "Codex (signed out)", mode: "unauth" },
          codex_old: { driver: "codex", displayName: "Codex (outdated)", mode: "old" },
          codex_broken: { driver: "codex", displayName: "Codex (broken CLI)", mode: "broken" },
          codex_nobin: { driver: "codex", displayName: "Codex (binary missing)", binaryPath: "/nonexistent/path/to/codex" },
        }
      : {
          grok_unauth: { displayName: "Grok (signed out)", mode: "unauth" },
          grok_old: { displayName: "Grok (outdated)", mode: "old" },
          grok_broken: { displayName: "Grok (broken CLI)", mode: "broken" },
          grok_nobin: { displayName: "Grok (binary missing)", binaryPath: "/nonexistent/path/to/grok" },
        },
  );
  await page.waitForTimeout(6000); // hot reload + provider probes
  await gotoPath(page, "/settings/providers");
  await must(page, page.getByText(claude ? "Claude (signed out)" : codex ? "Codex (signed out)" : "Grok (signed out)"), "signed out card");
  await page.waitForTimeout(5000);
  await shot("providers-top");
  await dumpPage(page, "s18 providers");
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, 650);
    await page.waitForTimeout(700);
    await shot(`providers-scroll-${i}`);
  }
}
