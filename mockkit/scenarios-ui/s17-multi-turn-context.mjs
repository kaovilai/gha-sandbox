// S17 multi-turn: untagged prompts hit the default `echo` scenario, which counts turns and quotes history.
// Turn 2 must quote turn 1's prompt: proves the session carries context across turns (same provider session).
import { expectText, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "Hello, mock agent");
  await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await expectText(page, /You said: "Hello, mock agent"\. This is the first turn\./, "turn 1 echoes the prompt and says it is the first turn");
  await shot("turn1");
  await sendPrompt(page, "And a second message");
  await page.getByText(/turn 2/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await expectText(page, /You said: "And a second message"\. Your previous message was: "Hello, mock agent"\./, "turn 2 quotes the previous message (conversation context kept)");
  await shot("turn2");
}
