// S59 subagent-approval (Codex): the child thread asks for approval (item/fileChange/requestApproval with the CHILD thread/turn ids).
// T3 flags the parent ("Open approval") and lets the user open the child thread and approve there. Needs Supervised mode.
import { ask, dumpPage, setRuntimeMode, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await ask(page, env, "subagent-approval", "Have a worker write the notes file.");
  await page.waitForTimeout(6000);
  const info = await dumpPage(page, "s59 child approval pending");
  console.log(`FINDING parent surfaces child approval: openApproval=${/Open approval/.test(info.text)} approvalBadge=${/Approval/.test(info.text)} approveButtonInParent=${/Approve/.test(info.text)}`);
  await shot("parent-pending");
  const open = page.getByRole("button", { name: /Open approval/ }).first();
  if (await open.isVisible().catch(() => false)) {
    await open.click();
    await page.waitForTimeout(2500);
    await shot("child-thread-approval");
    await dumpPage(page, "s59 child thread");
  } else {
    console.log("FINDING: no 'Open approval' button; looking for the Approve button directly");
  }
  const approve = await must(page, page.getByRole("button", { name: /^Approve$/ }), "Approve button for the child's file change", 30_000);
  await approve.click();
  await page.waitForTimeout(4000);
  await shot("after-approve");
  await dumpPage(page, "s59 after approve");
}
