// S01 first-run wizard: clean home, no onboarding flag (meta.firstRun) -> "/" redirects to /welcome (Connection, Agents, Projects).
import { dumpPage } from "../lib/ui.mjs";

export const meta = { firstRun: true };

export default async function ({ page, shot }) {
  await page.waitForTimeout(3500);
  await shot("welcome-1");
  await dumpPage(page, "s01 welcome step 1");
  console.log(`url: ${page.url()}`);
  const next = () => page.getByRole("button", { name: /^(Continue|Next|Get started|Skip|Skip for now)/i }).first();
  for (let i = 2; i <= 4; i++) {
    if (!(await next().isVisible().catch(() => false))) break;
    await next().click();
    await page.waitForTimeout(2500);
    await shot(`welcome-${i}`);
    await dumpPage(page, `s01 welcome step ${i}`);
  }
}
