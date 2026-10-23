// S11 plan/todo list: ACP `plan` session/update entries (progress shown in the plan/todo UI).
// NOTE: standard ACP `plan` maps to a todo list, not a ProposedPlanCard (needs xAI exit_plan_mode ext).
import { dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:plan] track the work");
  await page.waitForTimeout(1200);
  await shot("plan-early");
  await page.getByText(/Plan tracked above/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("plan-late");
  await dumpPage(page, "s11");
}
