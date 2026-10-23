// S09 approval-deny: Supervised mode, shell command needs approval, user clicks Decline, agent acknowledges.
import { ask, dumpPage, setRuntimeMode, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await ask(page, env, "approval-deny", "Clean the build output.");
  const decline = page.getByRole("button", { name: /^Decline$/ }).first();
  try {
    await decline.waitFor({ state: "visible", timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s09 no decline button");
    throw e;
  }
  await page.waitForTimeout(800);
  await shot("pending");
  await decline.click();
  await page.getByText(/Understood, I will leave/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("declined");
  await dumpPage(page, "s09 declined");
}
