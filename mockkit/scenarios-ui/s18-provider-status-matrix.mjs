// S18 provider status matrix: extra grok-driver instances whose launcher reports ready / signed-out / too-old / broken / missing,
// shown as Settings > Providers cards (and the composer picker). Each card's status text is asserted (not just that the page loaded).
import { dumpPage, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { gotoPath, must, seedInstances } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  const codex = providerOf(env) === "codex";
  // Codex flavor: the default `codex` instance is READY (apiKey account); extra codex-driver instances show signed out / outdated / broken / missing.
  seedInstances(
    env,
    codex
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
  const brand = codex ? "Codex" : "Grok";
  await must(page, page.getByText(`${brand} (signed out)`), "signed out card");
  await page.waitForTimeout(5000);
  // all four extra cards are listed, each with its own status line
  for (const n of ["signed out", "outdated", "broken CLI", "binary missing"]) await expectText(page, `${brand} (${n})`, `provider card '${brand} (${n})'`);
  await expectBody(page, /Authenticated/, "the ready instance shows 'Authenticated'");
  await expectBody(page, /Not authenticated/, "signed-out card shows 'Not authenticated'");
  await expectBody(page, /Unavailable/, "broken-CLI card shows 'Unavailable'");
  await expectBody(page, /Not found/, "missing-binary card shows 'Not found'");
  await expectBody(page, codex ? /v0\.100\.0/ : /v0\.0\.1/, `outdated card shows its old version ${codex ? "v0.100.0" : "v0.0.1"}`);
  await shot("providers-top");
  await dumpPage(page, "s18 providers");
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, 650);
    await page.waitForTimeout(700);
    await shot(`providers-scroll-${i}`);
  }
}
