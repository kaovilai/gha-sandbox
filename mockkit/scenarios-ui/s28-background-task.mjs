// S28 background task: upstream acp-mock-agent.ts with T3_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED=1 behind the grok driver.
// Exploratory: records what T3 shows for a started background task.
import { composerEditor, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { pickInstance, seedUpstreamGrok } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  seedUpstreamGrok(env, "grok_bg", "Upstream (background task)", { T3_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED: "1" });
  await startSession(page, env);
  await page.waitForTimeout(8000);
  await pickInstance(page, "Upstream (background task)", { shot, model: "Grok Build" });
  await composerEditor(page).click();
  await sendPrompt(page, "Start the dev server in the background.");
  await page.waitForTimeout(12_000);
  await shot("after-send");
  await dumpPage(page, "s28 after send");
  if (await page.getByText(/Mock agent, turn/).first().isVisible().catch(() => false)) throw new Error("turn ran on the built-in mock, not the upstream agent");
  await page.waitForTimeout(6000);
  await shot("later");
  await dumpPage(page, "s28 later");
}
