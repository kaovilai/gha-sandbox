// S07 shell-command-output: REAL `sh -c` loop with ANSI colour, streamed as tool output while running.
import { dumpPage, expandWork, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:shell] run the build");
  await page.waitForTimeout(3500);
  await shot("running");
  await dumpPage(page, "s07 running");
  await page.getByText(/finished successfully/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  await expandWork(page);
  // open the command row to show the streamed output
  await page.getByText(/while \[/).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await shot("done");
  await dumpPage(page, "s07 done");
}
