// S18 provider status matrix: extra grok-driver instances whose launcher reports ready / signed-out / too-old / broken / missing,
// shown as Settings > Providers cards (and the composer picker).
import { dumpPage, startSession } from "../lib/ui.mjs";
import { gotoPath, must, seedInstances } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  seedInstances(env, {
    grok_unauth: { displayName: "Grok (signed out)", mode: "unauth" },
    grok_old: { displayName: "Grok (outdated)", mode: "old" },
    grok_broken: { displayName: "Grok (broken CLI)", mode: "broken" },
    grok_nobin: { displayName: "Grok (binary missing)", binaryPath: "/nonexistent/path/to/grok" },
  });
  await page.waitForTimeout(6000); // hot reload + provider probes
  await gotoPath(page, "/settings/providers");
  await must(page, page.getByText("Grok (signed out)"), "Grok (signed out) card");
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
