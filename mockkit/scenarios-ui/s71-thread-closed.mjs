// S71 thread closed (Codex): a background terminal is still running when Codex unloads the idle thread. thread/closed kills the
// terminal WITHOUT completing its command item; T3 terminalizes the item as interrupted ("terminalizeRunningCommandItems") and stops
// treating the thread as having background work. Hold gate `bg71` (the scenario's `until`) triggers the close after the running state
// is captured. Codex flavor only.
import { ask, dumpPage, expandRows, expandWork, expectText, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "bg-terminal", "Start a queue worker in a background terminal.", { close: "1", until: "bg71" });
  await expectText(page, /The worker is running in the background\./, "assistant closing sentence of the turn that started the worker", 60_000);
  await waitReached("bg71", 60_000, env);
  await page.waitForTimeout(2000);
  const before = await dumpPage(page, "s71 worker running");
  console.log(`FINDING before thread/closed: runningBanner=${/Running:/.test(before.text)} stopButton=${/Stop/.test(before.text)} status=${JSON.stringify(before.text.match(/^(Working|Running|Done|Idle)$/m)?.[0] ?? null)}`);
  await expandWork(page);
  await expandRows(page, { type: "command" });
  await shot("worker-running");
  release("bg71", env); // mock: kill the terminal + thread/closed
  await page.waitForTimeout(6000);
  await expandRows(page, { type: "command" }); // the work log stays expanded from above (a second expandWork would collapse it)
  const after = await dumpPage(page, "s71 after thread/closed");
  console.log(`FINDING after thread/closed: runningBanner=${/Running:/.test(after.text)} interruptedMarker=${/interrupted|stopped|cancelled|Interrupted/i.test(after.text)} status=${JSON.stringify(after.text.match(/^(Working|Running|Done|Idle)$/m)?.[0] ?? null)}`);
  await shot("after-thread-closed");
}
