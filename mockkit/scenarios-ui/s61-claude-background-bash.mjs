// S61 background Bash (Claude): `Bash run_in_background:true` -> background_tasks_changed roster + task_started; the turn ends while the command
// runs (T3 composer banner "Running: ..." + Stop), then the CLI reports task_notification (held by a hold gate so the running state can be captured)
// and wakes itself with a turn that reports the result. Phase 2: TaskOutput (read what it printed) and TaskStop (kill) tool rows.
import { ask, bodyText, dumpPage, expandRows, expandWork, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s61 is Claude-specific (background Bash frames); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "background-bash", "Run the build in the background.", { until: "bg61" });
  await expectText(page, /The build is running in the background\./, "assistant closing sentence of the turn", 60_000);
  await waitReached("bg61", 60_000, env); // the command exited; only the held completion report is outstanding
  await page.waitForTimeout(2500);
  const running = await dumpPage(page, "s61 task running");
  await finding("background-work banner (Running: Run the build) + Stop", async () => `banner=${/Running: [^\n]*Run the build/.test(running.text)} stop=${await page.getByRole("button", { name: /^Stop$/ }).first().isVisible().catch(() => false)} anyRunningText=${JSON.stringify(running.text.match(/Running[^\n]{0,80}/)?.[0] ?? null)}`);
  await shot("task-running");
  await expandWork(page);
  await expandRows(page, { type: "command" });
  await page.waitForTimeout(800);
  await shot("task-row");
  await finding("Bash row for the background command", async () => `build=${/Run the build|echo compiling/.test(await bodyText(page))}`);
  release("bg61", env);
  await expectBody(page, /Run the build finished \(exit 0\)\. Last line: build finished/, "wake-turn reply reporting the finished background command", 60_000);
  await page.waitForTimeout(5000);
  await shot("task-finished");
  const fin = await dumpPage(page, "s61 finished");
  await finding("banner cleared after completion", () => !/Running: [^\n]*Run the build/.test(fin.text));
  // phase 2: TaskOutput + TaskStop
  await ask(page, env, "background-bash", "Start the watcher, check its output, then stop it.", { mode: "stop" });
  await expectText(page, /The watcher was stopped\./, "closing sentence after TaskStop", 60_000);
  await page.waitForTimeout(2000);
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(800);
  const stopped = await dumpPage(page, "s61 stop phase");
  await finding("TaskOutput / TaskStop rows", () => `taskOutput=${/TaskOutput|Task output/i.test(stopped.text)} taskStop=${/TaskStop|Task stop|Stop task/i.test(stopped.text)} watcherLine=${/watcher started/.test(stopped.text)}`);
  await finding("banner gone after TaskStop", () => !/Running: [^\n]*file watcher/.test(stopped.text));
  await shot("task-stopped");
}
