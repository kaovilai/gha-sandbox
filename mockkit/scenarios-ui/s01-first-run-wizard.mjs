// S01 first-run wizard: clean home, no onboarding flag (meta.firstRun) -> "/" redirects to the setup wizard (Connect / Agents / Projects).
// The server is seeded with the mock CODEX provider (meta.seed), because the wizard only offers Codex + Claude as agents:
// the Agents step then shows the genuine connected state ("Ready"), and the driver walks all three steps to the app shell.
// Real assertions per step (heading, selected computer, agent Ready, project import step, landing in the app, wizard gone on reload).
import { assertShell, dumpPage, expectBody, expectNoText, expectText, expectVisible } from "../lib/ui.mjs";

export const meta = { firstRun: true, seed: { grok: "codex", codex: "codex" } };

export default async function ({ page, shot }) {
  const next = () => page.getByRole("button", { name: /^Continue/ }).first();
  const clickContinue = async (what) => {
    await expectVisible(page, next(), `${what}: Continue button`, 30_000);
    for (let i = 0; i < 40 && !(await next().isEnabled().catch(() => false)); i++) await page.waitForTimeout(250);
    if (!(await next().isEnabled().catch(() => false))) {
      await dumpPage(page, `s01 ${what}: Continue stays disabled`);
      throw new Error(`assertion failed: ${what}: Continue is disabled`);
    }
    await next().click();
  };

  // 1) Connect: this computer is listed and selected
  await expectText(page, /Connect your computers/, "wizard step 1 heading 'Connect your computers'", 60_000);
  await expectText(page, /Computers to set up|Add a computer/, "computer list / Add a computer", 20_000);
  const box = page.getByRole("checkbox").first();
  await expectVisible(page, box, "a computer checkbox on step 1");
  for (let i = 0; i < 40 && (await box.getAttribute("aria-checked").catch(() => null)) !== "true"; i++) await page.waitForTimeout(250);
  if ((await box.getAttribute("aria-checked").catch(() => null)) !== "true") {
    await dumpPage(page, "s01 computer not selected");
    throw new Error("assertion failed: this computer is not pre-selected on step 1");
  }
  await shot("welcome-1-connect");
  await dumpPage(page, "s01 step 1");
  await clickContinue("step 1");

  // 2) Agents: the mock Codex agent is connected and Ready; Claude is disabled
  await expectText(page, /Connect your agents/, "wizard step 2 heading 'Connect your agents'", 30_000);
  await expectText(page, /^Ready$/, "Codex agent card shows 'Ready' (mock provider connected)", 60_000);
  await expectBody(page, /Codex/, "Codex agent card");
  await expectBody(page, /Disabled/, "Claude shown as Disabled (seeded enabled:false)");
  await page.waitForTimeout(600);
  await shot("welcome-2-agents");
  await dumpPage(page, "s01 step 2");
  await clickContinue("step 2");

  // 3) Projects: import step; nothing to import on a clean runner, so skip
  await expectText(page, /Import your projects/, "wizard step 3 heading 'Import your projects'", 30_000);
  await expectBody(page, /No existing Claude Code or Codex projects found\.|Looking for projects|\d+ of \d+ selected/, "project scan result");
  await page.waitForTimeout(800);
  await shot("welcome-3-projects");
  await dumpPage(page, "s01 step 3");
  const skip = page.getByRole("button", { name: /^Do not import projects$/ });
  await expectVisible(page, skip, "'Do not import projects' button");
  await skip.click();

  // 4) Lands in the app shell, wizard gone (and stays gone after a reload: completion persisted)
  await assertShell(page, "app shell after the wizard", 60_000);
  await expectNoText(page, /Connect your agents|Import your projects|Connect your computers/, "wizard dialog still open after finishing");
  await page.waitForTimeout(800);
  await shot("welcome-4-app");
  await page.reload({ waitUntil: "load" });
  await assertShell(page, "app shell after reload", 60_000);
  await expectNoText(page, /Connect your agents|Import your projects|Connect your computers/, "wizard reappeared after reload (completion not persisted)");
  await shot("welcome-5-after-reload");
}
