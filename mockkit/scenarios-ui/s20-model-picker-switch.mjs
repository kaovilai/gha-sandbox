// S20 model picker: two mock provider instances; open the picker, browse, switch instance mid-thread, send a turn.
import { composerEditor, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { must, seedInstances } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  seedInstances(env, { grok_alt: { displayName: "Mock Alt", accentColor: "#d97706" } });
  await startSession(page, env);
  await page.waitForTimeout(4000);
  await sendPrompt(page, "Hello from the default model.");
  await page.getByText(/Mock agent, turn 1/).first().waitFor({ timeout: 60_000 });
  await page.keyboard.press("Control+Shift+M");
  await page.waitForTimeout(1200);
  await shot("picker-open");
  await dumpPage(page, "s20 picker (keyboard)");
  const alt = page.getByText("Mock Alt", { exact: false }).first();
  if (!(await alt.isVisible().catch(() => false))) {
    // fall back to the composer button
    await page.keyboard.press("Escape");
    await page.locator("button").filter({ hasText: /Mock (Build|Fast)/ }).last().click();
    await page.waitForTimeout(1200);
    await shot("picker-open-click");
  }
  await must(page, page.getByText("Mock Alt", { exact: false }), "Mock Alt provider in picker");
  await page.getByText("Mock Alt", { exact: false }).first().click();
  await page.waitForTimeout(1000);
  await shot("picker-alt-selected");
  await dumpPage(page, "s20 alt selected");
  const pick = page.getByText(/Mock Fast/).first();
  if (await pick.isVisible().catch(() => false)) {
    await pick.click();
    await page.waitForTimeout(800);
  }
  await page.keyboard.press("Escape");
  await composerEditor(page).click();
  await sendPrompt(page, "Now answer from the other provider.");
  await page.getByText(/Mock agent, turn/).nth(1).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1200);
  await shot("after-switch-turn");
  await dumpPage(page, "s20 after switch");
}
