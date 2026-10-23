// S21 context-meter (Codex): the composer's context-window ring (opt-in client setting contextWindowMeterEnabled) fed by
// thread/tokenUsage/updated {modelContextWindow: 258400}. Turn 1 small usage, turn 2 forces ~190k input tokens (queue arg tokens=).
// Meaningful for the codex provider (the Grok ACP mock reports no token usage). Asserts the meter exists after turn 2 and
// that its tooltip reads "74% · 190k/258k"; the Grok flavor (no usage reports) is only logged.
import { ask, bodyText, dumpPage, expectVisible, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  // page-level init scripts run after the context-level skipOnboarding one, so this overrides its localStorage value on reload
  await page.addInitScript(() => {
    localStorage.setItem("t3code:client-settings:v1", JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z", contextWindowMeterEnabled: true }));
  });
  await page.reload({ waitUntil: "load" });
  // Right after the reload "Add project" can land on Settings > Connections (environment not connected yet, seen in ~2 of 5 CI runs;
  // the typed path then ends up in the settings search). Retry from the app root, logging each failed attempt.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.waitForTimeout(2500);
      await startSession(page, env);
      break;
    } catch (e) {
      console.log(`FINDING s21 startSession attempt ${attempt} failed at ${page.url()}: ${String(e.message).split("\n")[0]}`);
      if (attempt >= 3) throw e;
      await page.goto(new URL("/", page.url()).href, { waitUntil: "load" });
    }
  }
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
  const label = await meter.getAttribute("aria-label").catch(() => null);
  console.log(`FINDING context meter visible after turn 2: ${seen} label=${JSON.stringify(label)}`);
  if (providerOf(env) === "codex") await expectVisible(page, meter, "context-window meter in the composer after the 190k-token turn", 15_000);
  if (seen) {
    await meter.hover();
    await page.waitForTimeout(1200);
    const t = await bodyText(page);
    console.log(`FINDING meter tooltip: ${t.match(/Context Window[^\n]*\n?[^\n]*/i)?.[0] ?? "none"}`);
    if (providerOf(env) === "codex" && !/74%\s*·\s*190k\/258k/.test(t)) {
      await dumpPage(page, "s21 meter tooltip without the expected usage");
      throw new Error("assertion failed: context meter tooltip should read '74% · 190k/258k' (190000 of 258400 tokens)");
    }
  } else {
    await dumpPage(page, "s21 no context meter");
  }
  await shot("turn2-meter-hover");
}
