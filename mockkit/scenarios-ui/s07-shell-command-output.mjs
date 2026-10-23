// S07 shell-command-output: REAL `sh -c` loop with ANSI colour, streamed as tool output while running.
import { dumpPage, expandWork, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:shell] run the build");
  await page.waitForTimeout(2500);
  await shot("running");
  // expand the live command row so streamed output (colour + progress lines) is visible mid-run
  await page.getByText(/Running command/).first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await shot("running-expanded");
  await dumpPage(page, "s07 running");
  await page.getByText(/finished successfully/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  await expandWork(page);
  // open the command row to show the streamed output
  if (!(await page.getByText(/build finished/).first().isVisible().catch(() => false))) {
    await page.getByText(/while \[/).first().click().catch(() => {});
  }
  await page.waitForTimeout(1000);
  await shot("done");
  await dumpPage(page, "s07 done");
}
