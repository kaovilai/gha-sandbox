// S16 queue/steer: a held turn is running; two more messages are sent and show up in the "Queued" list; one is steered.
import { ask, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "slow", "Run the long task.", { hold: "rec" });
  await waitReached("rec", 60_000, env);
  await page.waitForTimeout(800);
  await shot("running");
  await sendPrompt(page, "Also update the README when you are done.");
  await page.waitForTimeout(1200);
  await sendPrompt(page, "And then run the build.");
  await page.waitForTimeout(1500);
  await dumpPage(page, "s16 after two queued sends");
  await shot("queued-collapsed");
  const exp = page.getByRole("button", { name: /Expand queued messages/ }).first();
  if (await exp.isVisible().catch(() => false)) {
    await exp.click();
    await page.waitForTimeout(800);
  }
  await shot("queued-expanded");
  await dumpPage(page, "s16 queued expanded");
  const steer = page.getByRole("button", { name: /^Steer$/ }).first();
  if (await steer.isVisible().catch(() => false)) {
    await steer.click();
    await page.waitForTimeout(2500);
    await shot("steer-clicked");
    await dumpPage(page, "s16 steer clicked");
  } else {
    console.log("FINDING: no Steer button visible");
  }
  release("rec", env);
  await page.waitForTimeout(6000);
  await shot("after-release");
  await dumpPage(page, "s16 after release");
}
