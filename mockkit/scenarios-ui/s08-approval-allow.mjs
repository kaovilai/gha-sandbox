// S08 approval-allow: composer defaults to "Full access" (auto-approves), so first switch to a supervised
// mode; the mock then blocks on session/request_permission and the UI shows Approve/Decline.
// Screenshot pending, click Approve, screenshot resolved.
import { dumpPage, sendPrompt, setRuntimeMode, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await shot("mode-set");
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
