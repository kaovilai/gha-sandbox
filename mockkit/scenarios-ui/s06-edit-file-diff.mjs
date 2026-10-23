// S06 edit-file-diff: the mock REALLY writes src/greeting.ts + src/farewell.ts in the session cwd, then we
// open the Changes/Diff panel. FINDING (run 39927114133): the app's Changes/checkpoint DOES see these
// external edits (header "+5 -1", diff lists both files), so real fs writes give a real diff.
import { dumpPage, expandWork, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:edit-file-diff] update the greeting helper");
  await page.getByText(/Open the diff panel/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await expandWork(page);
  await shot("timeline");

  const changes = page.getByRole("button", { name: /Changes/ }).first();
  console.log(`FINDING header Changes button text: ${JSON.stringify((await changes.textContent().catch(() => null))?.trim())}`);
  await changes.click();
  await page.waitForTimeout(2000);
  await shot("diff-panel");
  // expand the modified file to show the actual hunk
  await page.getByText("src/greeting.ts").last().click().catch(() => {});
  await page.waitForTimeout(1500);
  await shot("diff-expanded");
  const info = await dumpPage(page, "s06 diff panel");
  console.log(`FINDING diff mentions greeting.ts: ${/greeting\.ts/.test(info.text)} farewell.ts: ${/farewell\.ts/.test(info.text)} welcome-line: ${/Welcome aboard/.test(info.text)}`);
}
