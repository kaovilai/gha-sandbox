// S15 interrupt-cancel: turn streams then HOLDs (mock gate "rec"); UI Stop -> session/cancel -> cancelled.
import { ask, dumpPage, expectNoText, expectText, expectVisible, startSession } from "../lib/ui.mjs";
import { waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "slow", "Run the long task.", { hold: "rec" });
  await waitReached("rec", 60_000, env);
  await page.waitForTimeout(1000);
  // running: partial text streamed, the turn is held, a Stop control is offered
  await expectText(page, /Working on a long task\./, "partial streamed text while the turn is held");
  const stop = page.getByRole("button", { name: /stop|interrupt|cancel/i }).first();
  await expectVisible(page, stop, "Stop button while the run is in progress");
  await shot("working");
  await dumpPage(page, "s15 working");
  await stop.click();
  // interrupted: the run is marked interrupted, the scripted ending never ran, no Stop control is left
  await expectText(page, /Run interrupted/, "'Run interrupted' marker in the timeline");
  await page.waitForTimeout(1500);
  await expectNoText(page, /Finished the long task/, "turn kept running after Stop (final sentence appeared)");
  await shot("interrupted");
  await dumpPage(page, "s15 interrupted");
}
