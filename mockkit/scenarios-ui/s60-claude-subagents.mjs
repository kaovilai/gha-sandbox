// S60 subagents (Claude): the Agent tool launches two subagents (`subagent-spawn`: explorer reads a file, builder runs a command). The mock sends
// the same frames the real CLI does (Agent tool_use, system task_started, child assistant/user frames tagged parent_tool_use_id, task_progress,
// task_notification, Agent tool_result). T3 projects them as subagent rows / child threads (lineage), not as tool rows.
// The first worker is held mid-run (hold gate) to capture the running state. What T3 renders is recorded as FINDING lines.
import { ask, dumpPage, expandRows, expandWork, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s60 is Claude-specific (Agent tool frames); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "subagent-spawn", "Map greet() usage and check the build script in parallel.", { hold: "sub60" });
  await waitReached("sub60", 60_000, env);
  await page.waitForTimeout(3000);
  const running = await dumpPage(page, "s60 child running");
  await finding("subagent rows while the first worker runs (explorer / prompt)", () => `explorer=${/explorer/i.test(running.text)} prompt=${/Find where greet/.test(running.text)}`);
  await shot("child-running");
  release("sub60", env);
  await expectText(page, /Both workers finished/, "root assistant closing sentence after both subagents returned", 90_000);
  await page.waitForTimeout(2000);
  await expandWork(page);
  await expandRows(page, { type: "subagent" });
  const done = await dumpPage(page, "s60 finished");
  await finding("subagents after finish (explorer, builder, child result text)", () => `explorer=${/explorer/i.test(done.text)} builder=${/builder/i.test(done.text)} result=${/not called anywhere else/.test(done.text)}`);
  await shot("finished");
  const summary = page.getByText(/\d+ subagents?/).first();
  if (await summary.isVisible().catch(() => false)) {
    await summary.click().catch(() => {});
    await page.waitForTimeout(1500);
    await shot("subagents-expanded");
    await dumpPage(page, "s60 subagents expanded");
  } else console.log("FINDING: no 'N subagents' summary row");
  const prev = page.getByText(/Previous agents/).first();
  if (await prev.isVisible().catch(() => false)) {
    await prev.click().catch(() => {});
    await page.waitForTimeout(1200);
    await shot("lineage-previous-agents");
  } else console.log("FINDING: no 'Previous agents' lineage entry");
  const open = page.getByText(/Find where greet\(\)|Check the build script|explorer|builder/).first();
  if (await open.isVisible().catch(() => false)) {
    await open.click().catch(() => {});
    await page.waitForTimeout(2500);
    await shot("child-thread");
    const child = await dumpPage(page, "s60 child thread");
    await finding("child thread shows the child's own tool/result", () => `read=${/greeting\.ts/.test(child.text)} text=${/not called anywhere else/.test(child.text)}`);
  } else console.log("FINDING: no obvious control to open the child thread");
}
