// S51 permission-request (Codex): item/permissions/requestApproval, the agent asks for filesystem write access outside the
// sandbox ("Write build output to dist/"). T3 renders an approval card with the reason; Approve grants the same profile.
// Needs Supervised mode. Grok flavor: degrades to a plain permission request.
import { ask, dumpPage, setRuntimeMode, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await ask(page, env, "perm-grant", "Run the build and keep the output.");
  await must(page, page.getByRole("button", { name: /^Approve$/ }), "Approve button (permission card)", 60_000);
  await page.waitForTimeout(800);
  const info = await dumpPage(page, "s51 pending");
  console.log(`FINDING reason shown: ${/Write build output to dist/.test(info.text)} card label: ${JSON.stringify(info.text.match(/(File change|File read|Command|App permission) approval/)?.[0] ?? null)}`);
  await shot("pending");
  await page.getByRole("button", { name: /^Approve$/ }).first().click();
  await page.getByText(/Granted: wrote/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("granted");
  // second request: decline -> empty permission grant -> onReject branch
  await ask(page, env, "perm-grant", "Run the build once more.");
  const decline = await must(page, page.getByRole("button", { name: /^Decline$/ }), "Decline button", 60_000);
  await page.waitForTimeout(800);
  await shot("second-pending");
  await decline.click();
  await page.getByText(/skipping the build output/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("declined");
  await dumpPage(page, "s51 declined");
}
