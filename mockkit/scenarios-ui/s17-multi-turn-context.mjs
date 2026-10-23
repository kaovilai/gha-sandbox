// S17 multi-turn: untagged prompts hit the default `echo` scenario, which counts turns and quotes history.
import { sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "Hello, mock agent");
  await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("turn1");
  await sendPrompt(page, "And a second message");
  await page.getByText(/turn 2/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("turn2");
}
