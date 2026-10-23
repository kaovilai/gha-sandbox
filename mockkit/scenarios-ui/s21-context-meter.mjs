// S21 context-meter (Codex): the composer's context-window ring (opt-in client setting contextWindowMeterEnabled) fed by
// thread/tokenUsage/updated {modelContextWindow: 258400}. Turn 1 small usage, turn 2 forces ~190k input tokens (queue arg tokens=).
// Meaningful for the codex provider (the Grok ACP mock reports no token usage).
import { ask, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  // page-level init scripts run after the context-level skipOnboarding one, so this overrides its localStorage value on reload
  await page.addInitScript(() => {
    localStorage.setItem("t3code:client-settings:v1", JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z", contextWindowMeterEnabled: true }));
  });
  await page.reload({ waitUntil: "load" });
  await startSession(page, env);
  await sendPrompt(page, "Hello, mock agent");
  await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("turn1-small-usage");
  const meter = page.getByRole("button", { name: /Context window/ }).first();
  const seen1 = await meter.isVisible().catch(() => false);
  console.log(`FINDING context meter visible after turn 1: ${seen1}`);
  await ask(page, env, "echo", "Now a much larger prompt.", { tokens: 190000 });
  await page.getByText(/turn 2/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const seen = await meter.isVisible().catch(() => false);
  console.log(`FINDING context meter visible after turn 2: ${seen} label=${JSON.stringify(await meter.getAttribute("aria-label").catch(() => null))}`);
  if (seen) {
    await meter.hover();
    await page.waitForTimeout(1200);
  } else {
    await dumpPage(page, "s21 no context meter");
  }
  await shot("turn2-meter-hover");
}
