// S34 settings tour: every Settings section by route; Appearance cycles light/dark and switches theme cards.
import { dumpPage, startSession } from "../lib/ui.mjs";
import { gotoPath } from "../lib/ui-extra.mjs";

const SECTIONS = ["general", "appearance", "keybindings", "providers", "source-control", "storage", "connections", "diagnostics", "open-source-licenses"];

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await page.waitForTimeout(1000);
  const failures = [];
  for (const s of SECTIONS) {
    try {
      await gotoPath(page, `/settings/${s}`);
      await page.waitForTimeout(1200);
      await shot(`settings-${s}`);
      if (s === "general") await dumpPage(page, "s34 general");
    } catch (e) {
      failures.push(s);
      console.log(`FINDING settings/${s}: ${String(e.message).split("\n")[0]}`);
    }
  }
  // Appearance: theme switching
  await gotoPath(page, "/settings/appearance");
  await dumpPage(page, "s34 appearance");
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  console.log(`html.dark initially: ${await isDark()}`);
  await page.keyboard.press("Control+Alt+Shift+A"); // appearance.cycle
  await page.waitForTimeout(900);
  console.log(`html.dark after cycle 1: ${await isDark()}`);
  await shot("appearance-cycle-1");
  await page.keyboard.press("Control+Alt+Shift+A");
  await page.waitForTimeout(900);
  console.log(`html.dark after cycle 2: ${await isDark()}`);
  await shot("appearance-cycle-2");
  const cards = page.locator('button[aria-label^="Use "]');
  const n = await cards.count();
  console.log(`theme cards: ${n}`);
  for (const i of [1, 3]) {
    if (i < n) {
      try {
        const label = await cards.nth(i).getAttribute("aria-label");
        await cards.nth(i).scrollIntoViewIfNeeded();
        await cards.nth(i).click();
        await page.waitForTimeout(1000);
        console.log(`clicked theme card: ${label}`);
        await shot(`theme-card-${i}`);
      } catch (e) {
        console.log(`FINDING theme card ${i}: ${String(e.message).split("\n")[0]}`);
      }
    }
  }
  if (failures.length) throw new Error(`settings routes failed: ${failures.join(", ")}`);
}
