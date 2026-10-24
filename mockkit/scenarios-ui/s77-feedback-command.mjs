// S77 /feedback (Codex only): the composer command uploads thread feedback through `feedback/upload`; T3 shows an upload banner and then
// "Feedback sent to OpenAI" with the returned id (+ "Copy ID"). The mock records the report (control dir feedback.jsonl), which proves the
// reason text and thread id really went over the wire.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composerEditor, dumpPage, expectText, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "Hello before I send feedback");
  await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await composerEditor(page).click();
  await composerEditor(page).pressSequentially("/feedback The composer lost my draft once", { delay: 15 });
  await page.waitForTimeout(900);
  await shot("typed");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  // a slash menu may swallow the first Enter
  if (/\/feedback/.test((await composerEditor(page).innerText().catch(() => "")) ?? "")) await page.keyboard.press("Enter");
  await expectText(page, /Feedback sent to OpenAI/, "feedback success banner", 60_000);
  await expectText(page, /Thread ID: [0-9a-f]{8}-/, "returned feedback id in the banner", 10_000);
  await page.waitForTimeout(800);
  await shot("feedback-sent");
  await dumpPage(page, "s77 feedback sent");
  const file = join(env.MOCK_CONTROL_DIR, "feedback.jsonl");
  if (!existsSync(file)) throw new Error(`assertion failed: the mock never received feedback/upload (${file} missing)`);
  const rec = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1));
  console.log(`FINDING feedback/upload params: ${JSON.stringify({ classification: rec.classification, includeLogs: rec.includeLogs, reason: rec.reason, hasThread: Boolean(rec.threadId) })}`);
  if (rec.reason !== "The composer lost my draft once") throw new Error(`assertion failed: reason on the wire was ${JSON.stringify(rec.reason)}`);
  await page.getByRole("button", { name: /Copy ID/ }).first().isVisible().then((v) => console.log(`FINDING Copy ID button visible: ${v}`));
}
