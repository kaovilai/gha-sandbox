// S11 plan/todo list: ACP `plan` session/update entries (progress shown in the plan/todo UI).
// NOTE: standard ACP `plan` maps to a todo list, not a ProposedPlanCard (needs xAI exit_plan_mode ext).
import { ask, dumpPage, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "plan", "Track the work for this change.");
  await page.waitForTimeout(1800);
  await shot("plan-early");
  await page.waitForTimeout(3000);
  await shot("plan-mid");
  await dumpPage(page, "s11 mid");
  await page.getByText(/Plan tracked above/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("plan-late");
  await dumpPage(page, "s11");
}
