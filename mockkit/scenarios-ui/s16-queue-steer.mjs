// S16 queue/steer: a held turn is running; two more messages are sent and show up in the "Queued" list; one is steered.
// Asserted: both queued messages are listed with a Steer control, the steered one is answered next ("turn 2 ... README"),
// and after the gate is released the second one runs too ("turn 3 ... build") and the Queued list is gone.
import { ask, dumpPage, expectBody, expectNoText, expectText, expectVisible, sendPrompt, startSession } from "../lib/ui.mjs";
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
  await expectText(page, /^Queued$/, "'Queued' header of the queue list");
  await shot("queued-collapsed");
  const exp = page.getByRole("button", { name: /Expand queued messages/ }).first();
  if (await exp.isVisible().catch(() => false)) {
    await exp.click();
    await page.waitForTimeout(800);
  }
  await expectText(page, "Also update the README when you are done.", "queued message 1 listed");
  await expectText(page, "And then run the build.", "queued message 2 listed");
  const steer = page.getByRole("button", { name: /^Steer$/ }).first();
  await expectVisible(page, steer, "Steer button on a queued message");
  await shot("queued-expanded");
  await dumpPage(page, "s16 queued expanded");
  await steer.click();
  await page.waitForTimeout(2500);
  await shot("steer-clicked");
  await dumpPage(page, "s16 steer clicked");
  release("rec", env);
  // the steered message is answered by the next turn (echo: "turn 2"), then the remaining one
  await expectBody(page, /Mock agent, turn 2\. You said: "Also update the README when you are done\."/, "steered message answered by turn 2", 60_000);
  await expectBody(page, /Mock agent, turn 3\. You said: "And then run the build\."/, "remaining queued message answered by turn 3", 60_000);
  await page.waitForTimeout(1500);
  await expectNoText(page, /^Queued$/m, "Queued list still shown after everything ran");
  await shot("after-release");
  await dumpPage(page, "s16 after release");
}
