// S11b proposed plan: xAI `exit_plan_mode` extension request -> T3 captures it as a ProposedPlanCard (+ plan actions menu).
import { ask, dumpPage, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  const toggle = page.locator('button[aria-label*="enter plan mode"]').first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(600);
    console.log("plan mode toggled on");
    await shot("plan-mode-on");
  } else {
    console.log("FINDING: no plan-mode toggle in the composer (grok provider); continuing in build mode");
    await dumpPage(page, "s11b no plan toggle");
  }
  await ask(page, env, "exit-plan", "Draft a plan for refactoring the greeting helper.");
  await page.getByText(/Refactor the greeting helper/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1800);
  await shot("plan-card");
  await dumpPage(page, "s11b plan card");
  const actions = page.getByRole("button", { name: "Plan actions" }).first();
  if (await actions.isVisible().catch(() => false)) {
    await actions.click();
    await page.waitForTimeout(700);
    await shot("plan-actions-menu");
    await page.keyboard.press("Escape");
  } else {
    console.log("FINDING: no Plan actions button");
  }
  await page.waitForTimeout(600);
  await shot("plan-final");
  await dumpPage(page, "s11b final");
}
