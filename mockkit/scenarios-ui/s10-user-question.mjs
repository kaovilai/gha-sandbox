// S10 user-question: mock sends _x.ai/ask_user_question; UI shows the pending-input panel; we answer.
import { dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:ask] help me choose");
  try {
    await page.getByText(/Which code style/).first().waitFor({ timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s10 no question");
    throw e;
  }
  await page.waitForTimeout(800);
  await shot("pending");
  await dumpPage(page, "s10 pending");
  await page.getByText(/Strict \(Recommended\)/).first().click();
  await page.waitForTimeout(600);
  await shot("selected-immediately-submits");
  await page.getByText(/going with/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  await shot("answered");
  await dumpPage(page, "s10 answered");
}
