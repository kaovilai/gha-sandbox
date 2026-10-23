// S12 todo entries: six-item checklist advancing pending -> in_progress -> completed, shown in the composer Tasks panel.
// Each phase is asserted: all six labels while running, the held turn has not finished at the nearly-done still, and the
// completion sentence arrives only after the gate is released.
import { ask, dumpPage, expectNoText, expectText, startSession } from "../lib/ui.mjs";
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
  await expectNoText(page, /All six checklist items are complete/, "completion sentence appeared while the turn is still held");
  await shot("todo-nearly-done");
  await dumpPage(page, "s12 nearly done");
  release("todo-end", env);
  await page.getByText(/All six checklist items are complete/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("todo-complete");
  await dumpPage(page, "s12 complete");
}
