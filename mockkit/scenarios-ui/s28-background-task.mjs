// S28 background task: the mock agent (xAI background-task protocol, scenario `background-task`) starts a persistent Monitor
// ("Watch the dev server") and ends its turn while the task is still pending. T3 then shows the composer's background-work
// banner ("Running: Start monitor: Watch the dev server" + Stop button) although the thread itself is Done. Releasing the gate
// (`until`) makes the task report completion (`_x.ai/task_completed` + Grok's own "task-completed" wake turn): T3 shows
// 'Monitor "..." finished' and the wake reply; the banner is then cleared (by itself or with its Stop button, asserted).
// Grok (ACP) flavor only: the background-task frames are an xAI extension.
import { ask, bodyText, dumpPage, expectBody, expectText, expectVisible, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

const BANNER = /Running: [^\n]*Watch the dev server/;

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "background-task", "Watch the dev server in the background.", { until: "bg28", kill: "1" });
  // the turn itself ends normally (thread is Done)...
  await expectText(page, /The dev server is running in the background\./, "assistant closing sentence of the turn", 60_000);
  await waitReached("bg28", 60_000, env); // the command has exited; only the held completion report is outstanding
  await page.waitForTimeout(1500);
  await expectText(page, /^Done$/, "thread status 'Done' (the run itself completed)", 20_000);
  await shot("turn-done");
  // ...but T3 still shows work in flight: the background-work banner above the composer (task label + Stop)
  await expectBody(page, BANNER, "background-work banner 'Running: ... Watch the dev server'", 30_000);
  await expectVisible(page, page.getByText(BANNER), "banner text is visible above the composer");
  await expectVisible(page, page.getByRole("button", { name: /^Stop$/ }), "Stop button on the background-work banner");
  await page.waitForTimeout(800);
  await shot("banner-running");
  await dumpPage(page, "s28 banner running");
  // completion report: T3 shows the "Monitor ... finished" row and runs the wake turn that reports the result
  release("bg28", env);
  await expectText(page, /Monitor "Watch the dev server" finished/, "'Monitor \"Watch the dev server\" finished' row after the completion report", 40_000);
  await expectText(page, /Watch the dev server finished \(exit 0\)\. Last line: dev server listening/, "wake-turn reply reporting the finished task", 40_000);
  await page.waitForTimeout(6000); // the wake run finishes; the banner is hidden while a run is active and may come back after it
  await shot("task-finished");
  // The persistent monitor's own item is only closed by Stop (the mock sends no kill result), so the banner may still be up
  // after the wake turn. Stop is the real user action for it: clicking it must clear the banner.
  const lingering = BANNER.test(await bodyText(page));
  console.log(`FINDING banner still shown after the wake turn: ${lingering}`);
  if (lingering) {
    await page.getByRole("button", { name: /^Stop$/ }).first().click();
    const t0 = Date.now();
    while (BANNER.test(await bodyText(page))) {
      if (Date.now() - t0 > 30_000) {
        await dumpPage(page, "s28 banner survived Stop");
        throw new Error("assertion failed: background-work banner is still shown 30s after clicking its Stop button");
      }
      await page.waitForTimeout(400);
    }
    console.log(`FINDING banner cleared ${Date.now() - t0}ms after clicking Stop`);
  }
  await page.waitForTimeout(1500);
  await shot("banner-cleared");
  await dumpPage(page, "s28 after completion");
}
