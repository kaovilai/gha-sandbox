// S06 edit-file-diff: the mock REALLY writes src/greeting.ts + src/farewell.ts in the session cwd, then we
// open the Changes/Diff panel. Records whether the checkpoint captures edits made outside the provider's
// own fs API (printed as FINDING lines in the run log).
import { addProject, dumpPage, newMockThread, sendPrompt } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await page.waitForTimeout(2500);
  const project = await addProject(page, env.MOCKKIT_WS, { shot });
  await newMockThread(page, { project, shot });
  await sendPrompt(page, "[mock:edit-file-diff] update the greeting helper");
  await page.getByText(/Open the diff panel/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2000);
  await shot("timeline");
  await dumpPage(page, "s06 after edit");

  const changes = page.getByRole("button", { name: /Changes/ }).first();
  console.log(`FINDING header Changes button text: ${JSON.stringify((await changes.textContent().catch(() => null))?.trim())}`);
  await changes.click();
  await page.waitForTimeout(2500);
  await shot("diff-panel");
  const info = await dumpPage(page, "s06 diff panel");
  console.log(`FINDING diff panel mentions greeting.ts: ${/greeting\.ts/.test(info.text)} farewell.ts: ${/farewell\.ts/.test(info.text)}`);
}
