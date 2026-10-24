// S21 context-meter (Codex): the composer's context-window ring (opt-in client setting contextWindowMeterEnabled) fed by
// thread/tokenUsage/updated {modelContextWindow: 258400}. Turn 1 small usage, turn 2 forces ~190k input tokens (queue arg tokens=).
// Meaningful for the codex provider (the Grok ACP mock reports no token usage). Asserts the meter exists after turn 2 and
// that its tooltip reads "74% · 190k/258k"; the Grok flavor (no usage reports) is only logged.
import { ask, assertShell, bodyText, dumpPage, expectBody, expectVisible, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";

// Turning the meter on used to be `localStorage` + `page.reload()` followed by "Add project": the reload re-creates the web client's
// environment registry, and T3's openAddProjectFlow (CommandPalette.tsx) sends the user to /settings/connections when no environment is in
// the "connected" phase yet (the button renders before the websocket connects). That was the flake (typed path landed in the settings
// search, ~2 of 5 runs). Now the switch is flipped where a user flips it (Settings > General > Legacy features > "Context window indicator
// (legacy)"), client-side, WITHOUT a reload: the environment stays connected the whole time and Escape returns to the app.
async function enableContextMeter(page) {
  await assertShell(page, "app shell before opening settings");
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expectBody(page, /Settings\s*\/\s*General/, "settings opened on General", 30_000);
  const sw = page.getByLabel("Context window indicator (legacy)").first();
  if (!(await sw.isVisible().catch(() => false))) await page.getByRole("button", { name: /Legacy features/ }).first().click(); // collapsed group
  await expectVisible(page, sw, "switch 'Context window indicator (legacy)' in Settings > General > Legacy features");
  if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
  const t0 = Date.now();
  while ((await sw.getAttribute("aria-checked").catch(() => null)) !== "true") {
    if (Date.now() - t0 > 10_000) throw new Error("assertion failed: 'Context window indicator (legacy)' switch did not turn on");
    await page.waitForTimeout(200);
  }
  await page.keyboard.press("Escape"); // settings: Escape goes back to the app (client-side navigation)
  await assertShell(page, "app shell after closing settings");
}

export default async function ({ page, shot, env }) {
  await enableContextMeter(page);
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
