// S28 background task: the mock agent (xAI background-task protocol, scenario `background-task`) starts a persistent Monitor
// ("Watch the dev server") and ends its turn while the task is still pending. T3 then shows the composer's background-work
// banner (task label + Stop button), which clears when the task reports completion (`_x.ai/task_completed`).
// The completion is held by a gate (`until`) so the pending state can be pinned, asserted and recorded first.
// Grok (ACP) flavor only: the background-task frames are an xAI extension.
import { ask, bodyText, dumpPage, expectLocatorText, expectText, expectVisible, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "background-task", "Watch the dev server in the background.", { until: "bg28" });
  // the turn itself ends normally...
  await expectText(page, /The dev server is running in the background\./, "assistant closing sentence of the turn", 60_000);
  await waitReached("bg28", 60_000, env); // the command has exited; only the held completion report is outstanding
  await page.waitForTimeout(1500);
  await shot("turn-done");
  // ...but T3 still shows work in flight: the background-work banner above the composer (banner stack: label + Stop)
  const stack = page.locator('[data-composer-banner-stack="true"]');
  await expectLocatorText(page, stack, /Watch the dev server/, "background-work banner 'Watch the dev server' in the composer banner stack", 30_000);
  await expectVisible(page, stack.getByRole("button", { name: /^Stop$/ }), "Stop button on the background-work banner");
  console.log(`FINDING banner stack text: ${JSON.stringify(await stack.first().innerText())}`);
  await page.waitForTimeout(800);
  await shot("banner-running");
  await dumpPage(page, "s28 banner running");
  // completion report -> banner clears
  release("bg28", env);
  const t0 = Date.now();
  for (;;) {
    const t = await stack.first().innerText({ timeout: 1500 }).catch(() => "");
    if (!/Watch the dev server/.test(t)) break;
    if (Date.now() - t0 > 40_000) {
      await dumpPage(page, "s28 banner never cleared");
      throw new Error("assertion failed: background-work banner is still shown 40s after the task reported completion");
    }
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(1500);
  console.log(`FINDING page text after completion mentions finished task: ${/finished|completed|exit 0/i.test(await bodyText(page))}`);
  await shot("banner-cleared");
  await dumpPage(page, "s28 after completion");
}
