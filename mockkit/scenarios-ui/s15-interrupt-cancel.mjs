// S15 interrupt-cancel: turn streams then HOLDs (mock gate "rec"); UI Stop -> session/cancel -> cancelled.
import { dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:slow hold=rec] run the long task");
  await waitReached("rec", 60_000, env);
  await page.waitForTimeout(1000);
  await shot("working");
  await dumpPage(page, "s15 working");
  const stop = page.getByRole("button", { name: /stop|interrupt|cancel/i }).first();
  await stop.click();
  await page.waitForTimeout(2500);
  await shot("interrupted");
  await dumpPage(page, "s15 interrupted");
}
