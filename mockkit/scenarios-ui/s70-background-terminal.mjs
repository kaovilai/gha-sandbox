// S70 background terminal (Codex): the agent starts the dev server and ends its turn while the commandExecution item is still running
// (a background terminal that outlives its turn). T3 keeps the settled turn alive and projects the late output; when the command exits
// it re-prompts the agent with a continuation message ("Background command completed (exit N): ..."), which the mock answers (`bg-wake`).
// Hold gate `bg70` (the scenario's `until`) keeps the completion back so the running state can be captured first.
// Codex flavor only: Grok has its own background-task protocol (S28), Claude runs the command as a plain foreground step.
import { ask, bodyText, dumpPage, expandRows, expandWork, expectBody, expectText, nextScenario, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "bg-terminal", "Start the dev server in a background terminal.", { until: "bg70" });
  await expectText(page, /The dev server is running in the background\./, "assistant closing sentence of the turn that started the terminal", 60_000);
  await waitReached("bg70", 60_000, env); // the shell has exited; only the held completion is outstanding
  await page.waitForTimeout(2000);
  const running = await dumpPage(page, "s70 terminal still running");
  console.log(`FINDING while the terminal runs: status=${JSON.stringify(running.text.match(/^(Working|Running|Done|Idle)$/m)?.[0] ?? null)} runningBanner=${/Running:/.test(running.text)} stopButton=${/Stop/.test(running.text)} commandRow=${/dev server|bash -lc|Running command/i.test(running.text)}`);
  await shot("running-in-background");
  await expandWork(page);
  await expandRows(page, { type: "command" });
  await page.waitForTimeout(800);
  await shot("work-log-expanded");
  // T3 re-prompts the agent when the command completes: queue the wake reply, then let the command report completion
  nextScenario(env, "bg-wake");
  release("bg70", env);
  await expectText(page, /The background command finished, so I picked the work back up/, "agent reply to T3's background-completion continuation", 90_000);
  await page.waitForTimeout(2500);
  const m = await expectBody(page, /T3 reported: "([^"]*)"/, "the continuation message T3 sent is echoed by the wake reply", 20_000);
  console.log(`FINDING continuation text T3 sent: ${JSON.stringify(m[1])}`);
  if (!/Background command completed/.test(m[1])) throw new Error(`assertion failed: continuation text does not announce the completed background command: ${m[1]}`);
  if (!/dev server listening|node|bash|exit/.test(m[1])) console.log("FINDING: continuation text does not name the command");
  await shot("woken-by-completion");
  const after = await dumpPage(page, "s70 after wake");
  console.log(`FINDING after wake: completedRow=${/Background (command|work|task)/i.test(after.text)} body-has-exit-0=${/exit 0/.test(await bodyText(page))}`);
}
