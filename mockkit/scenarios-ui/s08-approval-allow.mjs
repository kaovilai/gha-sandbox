// S08 approval-allow: the mock blocks on session/request_permission; the UI shows Approve/Decline.
// Screenshot pending, click Approve, screenshot resolved (file written, turn completed).
import { addProject, dumpPage, newMockThread, sendPrompt } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await page.waitForTimeout(2500);
  const project = await addProject(page, env.MOCKKIT_WS, { shot });
  await newMockThread(page, { project, shot });
  await sendPrompt(page, "[mock:approval-allow] please write a notes file");
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  try {
    await approve.waitFor({ state: "visible", timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s08 no approve button");
    throw e;
  }
  await page.waitForTimeout(800);
  await shot("pending");
  await dumpPage(page, "s08 pending");
  await approve.click();
  await page.getByText(/Approved:/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("resolved");
  await dumpPage(page, "s08 resolved");
}
