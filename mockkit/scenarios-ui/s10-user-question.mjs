// S10 user-question: mock sends _x.ai/ask_user_question; UI shows the pending-input panel; we answer.
// Asserts the question and BOTH options are shown, then that the chosen option comes back to the agent verbatim.
import { ask, dumpPage, expectText, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "ask", "Help me choose a code style.");
  try {
    await page.getByText(/Which code style/).first().waitFor({ timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s10 no question");
    throw e;
  }
  await expectText(page, /Which code style should the mock follow\?/, "the full question text");
  await expectText(page, /Strict \(Recommended\)/, "option 'Strict (Recommended)'");
  await expectText(page, /Flexible/, "option 'Flexible'");
  await page.waitForTimeout(800);
  await shot("pending");
  await dumpPage(page, "s10 pending");
  await page.getByText(/Strict \(Recommended\)/).first().click();
  await page.waitForTimeout(600);
  await shot("option-clicked-submitted");
  await page.getByText(/going with/).first().waitFor({ timeout: 60_000 });
  await expectText(page, /going with: \["Strict \(Recommended\)"\]/, "agent echoes the chosen answer");
  await page.waitForTimeout(1000);
  await shot("answered");
  await dumpPage(page, "s10 answered");
}
