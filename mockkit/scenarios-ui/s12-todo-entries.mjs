// S12 todo entries: six-item checklist advancing pending -> in_progress -> completed, shown in the composer Tasks panel.
// Each phase is asserted: all six labels while running; at the nearly-done still the turn is STRUCTURALLY unfinished (the composer
// still offers Stop and the Tasks header counts 5/6: no dependence on the wording of the closing sentence); after the gate is
// released the turn ends (Stop gone) and the completion sentence arrives.
import { ask, bodyText, dumpPage, expectBody, expectText, expectVisible, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

const ITEMS = ["Read package.json", "Find greeting call sites", "Rewrite greet() helper", "Add farewell() helper", "Update README usage", "Run the build"];

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "todo", "Track a six-step checklist for this change.", { hold: "todo-end" });
  const tasks = page.getByText(/^Tasks/).first();
  await tasks.waitFor({ state: "visible", timeout: 60_000 });
  await tasks.click(); // starts collapsed
  await page.waitForTimeout(1200);
  for (const item of ITEMS) await expectText(page, item, `Tasks panel lists '${item}'`);
  await shot("todo-early");
  await dumpPage(page, "s12 early");
  await waitReached("todo-end", 60_000, env); // holds with item 6 in progress, items 1-5 completed
  await page.waitForTimeout(800);
  const stop = page.getByRole("button", { name: /stop|interrupt|cancel/i }).first();
  await expectVisible(page, stop, "Stop button while the turn is held (the run is still in progress)");
  await expectBody(page, /\b5\/6\b/, "Tasks header counts 5/6 while item 6 is in progress");
  if (/\b6\/6\b/.test(await bodyText(page))) throw new Error("assertion failed: Tasks header already counts 6/6 while the turn is held");
  await shot("todo-nearly-done");
  await dumpPage(page, "s12 nearly done");
  release("todo-end", env);
  await page.getByText(/All six checklist items are complete/).first().waitFor({ timeout: 60_000 });
  // the turn ended: no Stop control is offered any more (structural, not wording)
  const t0 = Date.now();
  while (await stop.isVisible().catch(() => false)) {
    if (Date.now() - t0 > 30_000) {
      await dumpPage(page, "s12 stop still visible after the turn ended");
      throw new Error("assertion failed: Stop button still offered 30s after the held turn was released and finished");
    }
    await page.waitForTimeout(300);
  }
  console.log(`FINDING Tasks header after completion mentions 6/6: ${/\b6\/6\b/.test(await bodyText(page))}`);
  await page.waitForTimeout(1500);
  await shot("todo-complete");
  await dumpPage(page, "s12 complete");
}
