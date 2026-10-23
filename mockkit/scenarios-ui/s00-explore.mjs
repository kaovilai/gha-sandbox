// Exploratory: what does the app look like with the mock seeded? Dumps text/controls into the run log.
import { dumpPage } from "../lib/ui.mjs";

export default async function ({ page, shot }) {
  await page.waitForTimeout(4000);
  await shot("home");
  await dumpPage(page, "home");

  // Settings (try link/button by name, fall back to the URL).
  const settings = page.getByRole("link", { name: /settings/i }).or(page.getByRole("button", { name: /settings/i })).first();
  if (await settings.isVisible().catch(() => false)) await settings.click();
  else await page.goto(new URL("/settings", page.url()).href);
  await page.waitForTimeout(2500);
  await shot("settings");
  await dumpPage(page, "settings");

  const prov = page.getByText(/providers?/i).first();
  if (await prov.isVisible().catch(() => false)) {
    await prov.click().catch(() => {});
    await page.waitForTimeout(2500);
    await shot("settings-providers");
    await dumpPage(page, "settings-providers");
  }
}
