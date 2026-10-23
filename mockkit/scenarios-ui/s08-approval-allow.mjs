// S08 approval-allow: composer defaults to "Full access" (auto-approves), so first switch to a supervised
// mode; the mock then blocks on session/request_permission and the UI shows Approve/Decline.
// Screenshot pending (nothing written yet: checked on disk), click Approve, screenshot resolved (file really written).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, dumpPage, expectText, expectVisible, setRuntimeMode, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  const notes = join(env.MOCKKIT_WS, "NOTES.md");
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await expectVisible(page, page.locator("button").filter({ hasText: /^\s*Supervised\s*$/ }), "composer runtime mode reads 'Supervised'");
  await shot("mode-set");
  await ask(page, env, "approval-allow", "Please write a notes file.");
  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  try {
    await approve.waitFor({ state: "visible", timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s08 no approve button");
    throw e;
  }
  await expectVisible(page, page.getByRole("button", { name: /^Decline$/ }), "Decline button next to Approve");
  await expectText(page, /NOTES\.md/, "approval card names NOTES.md");
  await page.waitForTimeout(800);
  if (existsSync(notes)) throw new Error("assertion failed: NOTES.md already exists while the approval is pending (agent ignored the gate)");
  await shot("pending");
  await dumpPage(page, "s08 pending");
  await approve.click();
  await page.getByText(/Approved:/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  if (!existsSync(notes) || !/Created by the mock agent after approval/.test(readFileSync(notes, "utf8"))) throw new Error("assertion failed: NOTES.md was not written after Approve");
  await expectText(page, /Approved: .*NOTES\.md.* was written/, "agent's confirmation text after approval");
  await shot("resolved");
  await dumpPage(page, "s08 resolved");
}
