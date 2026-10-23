// S11b proposed plan: xAI `exit_plan_mode` extension request -> T3 captures it as a ProposedPlanCard (+ plan actions menu).
import { readFileSync } from "node:fs";
import { ask, dumpPage, providerOf, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  const toggle = page.locator('button[aria-label*="enter plan mode"]').first();
  let planOn = false;
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
    await page.waitForTimeout(600);
    console.log("plan mode toggled on");
    planOn = true;
    await shot("plan-mode-on");
  } else if (providerOf(env) === "claude" && (await page.getByRole("button", { name: "More composer controls" }).first().isVisible().catch(() => false))) {
    // narrow composer (Claude shows an extra effort control): the Chat/Plan radio lives in the overflow menu
    await page.getByRole("button", { name: "More composer controls" }).first().click();
    await page.waitForTimeout(500);
    await shot("composer-overflow-menu");
    await page.getByRole("menuitemradio", { name: /^Plan$/ }).first().click();
    await page.waitForTimeout(600);
    await page.keyboard.press("Escape").catch(() => {});
    console.log("plan mode toggled on (composer overflow menu)");
    planOn = true;
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
  if (providerOf(env) === "claude" && planOn) {
    // server truth: the Claude CLI session was started in (or switched to) permission mode "plan"
    const frames = readFileSync(env.MOCK_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const modes = frames.filter((f) => f.dir === "out" && f.frame?.type === "system" && f.frame?.subtype === "init").map((f) => f.frame.permissionMode);
    console.log(`FINDING claude init permissionMode per turn: ${modes.join(",")}`);
    if (!modes.includes("plan")) throw new Error(`plan mode was toggled but the Claude CLI never reported permissionMode "plan" (saw: ${modes.join(",")})`);
  }
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
