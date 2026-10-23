// S28 background task: the mock agent (xAI background-task protocol, scenario `background-task`) starts a persistent Monitor
// ("Watch the dev server") and ends its turn while the task is still pending. T3 then shows the composer's background-work
// banner ("Running: Start monitor: Watch the dev server" + Stop button) although the thread itself is Done; the banner clears
// when the task reports completion (`_x.ai/task_completed`).
// The completion is held by a gate (`until`) so the pending state can be pinned, asserted and recorded first.
// Grok (ACP) flavor only: the background-task frames are an xAI extension.
import { ask, bodyText, dumpPage, expectBody, expectText, expectVisible, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

const BANNER = /Running: [^\n]*Watch the dev server/;

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "background-task", "Watch the dev server in the background.", { until: "bg28" });
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
  // completion report -> banner clears
  release("bg28", env);
  const t0 = Date.now();
  while (BANNER.test(await bodyText(page))) {
    if (Date.now() - t0 > 40_000) {
      await dumpPage(page, "s28 banner never cleared");
      throw new Error("assertion failed: background-work banner is still shown 40s after the task reported completion");
    }
    await page.waitForTimeout(400);
  }
  // T3 ran the wake turn: the reply that reports the finished task is in the thread
  await expectText(page, /Watch the dev server finished \(exit 0\)\. Last line: dev server listening/, "wake-turn reply reporting the finished task", 40_000);
  await page.waitForTimeout(1500);
  console.log(`FINDING banner cleared ${Date.now() - t0}ms after the completion report; page mentions finished task: ${/finished|completed|exit 0/i.test(await bodyText(page))}`);
  await shot("banner-cleared");
  await dumpPage(page, "s28 after completion");
}
