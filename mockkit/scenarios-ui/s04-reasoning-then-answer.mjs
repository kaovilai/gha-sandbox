// S04 reasoning-then-answer: agent_thought_chunk stream, then the answer.
import { dumpPage, expandWork, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:think] which design should we pick?");
  await page.waitForTimeout(1800);
  await shot("thinking");
  await page.getByText(/simpler approach wins/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("answer");
  await expandWork(page);
  await shot("expanded");
  await dumpPage(page, "s04");
}
