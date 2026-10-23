// S28 background task: the mock agent (xAI background-shell protocol, scenario `background-task`) starts a shell command in the
// background and ends its turn while the task is still running. T3 then shows the composer's background-work banner
// ("Running: Run the dev server"), which clears when the task reports completion (`_x.ai/task_completed`).
// The task completion is held by a gate (`until`) so the running state can be pinned, asserted and recorded first.
// Grok (ACP) flavor only: the background-task frames are an xAI extension.
import { ask, dumpPage, expectBody, expectText, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

const RUNNING = /Running(: [^\n]+| a [a-z ]+)/;

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "background-task", "Start the dev server in the background.", { until: "bg28" });
  // the turn itself ends normally...
  await expectText(page, /The dev server is running in the background\./, "assistant closing sentence of the turn", 60_000);
  await waitReached("bg28", 60_000, env); // the command has exited; only the held completion report is outstanding
  await page.waitForTimeout(1500);
  await shot("turn-done");
  // ...but T3 still shows work in flight: the background-work banner above the composer
  const m = await expectBody(page, RUNNING, "background-work banner 'Running: ...' above the composer", 30_000);
  console.log(`FINDING background banner text: ${JSON.stringify(m[0])}`);
  await expectBody(page, /Run the dev server/, "banner / row names the task 'Run the dev server'");
  await page.waitForTimeout(800);
  await shot("banner-running");
  await dumpPage(page, "s28 banner running");
  // completion report -> banner clears
  release("bg28", env);
  const t0 = Date.now();
  for (;;) {
    const text = await page.evaluate(() => document.body.innerText);
    if (!RUNNING.test(text)) break;
    if (Date.now() - t0 > 40_000) {
      await dumpPage(page, "s28 banner never cleared");
      throw new Error("assertion failed: background-work banner is still shown 40s after the task reported completion");
    }
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1500);
  await shot("banner-cleared");
  await dumpPage(page, "s28 after completion");
}
