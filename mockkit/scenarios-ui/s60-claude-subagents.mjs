// S60 subagents (Claude): the Agent tool launches two subagents (`subagent-spawn`: explorer reads a file, builder runs a command). The mock sends
// the same frames the real CLI does (Agent tool_use, system task_started, child assistant/user frames tagged parent_tool_use_id, task_progress,
// task_notification, Agent tool_result). T3 projects them as subagent rows / child threads (lineage), not as tool rows.
// The first worker is held mid-run (hold gate) to capture the running state. What T3 renders is recorded as FINDING lines.
import { ask, dumpPage, expandRows, expandWork, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s60 is Claude-specific (Agent tool frames); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "subagent-spawn", "Map greet() usage and check the build script in parallel.", { hold: "sub60" });
  await waitReached("sub60", 60_000, env);
  await page.waitForTimeout(3000);
  const running = await dumpPage(page, "s60 child running");
  // observed: running subagent row "explorer Running / Running Read src/greeting.ts" + a Lineage panel entry "Lineage . 1 running"
  await expectBody(page, /explorer/, "running subagent row named after subagent_type", 10_000);
  await expectBody(page, /Lineage/, "Lineage panel lists the running child", 10_000);
  await expectBody(page, /Running/, "subagent row status Running", 10_000);
  await finding("subagent prompt visible while running", () => `prompt=${/Find where greet/.test(running.text)}`);
  await shot("child-running");
  release("sub60", env);
  await expectText(page, /Both workers finished/, "root assistant closing sentence after both subagents returned", 90_000);
  await page.waitForTimeout(2000);
  await dumpPage(page, "s60 finished");
  await shot("finished");
  // observed: finished subagents collapse into a "2 subagents / 2 done" summary row; expanding it lists explorer + builder with their results
  await expandWork(page);
  await expectBody(page, /2 subagents/, "both subagents grouped in a summary row", 10_000);
  await page.getByText(/^2 subagents/).first().click();
  await page.waitForTimeout(1500);
  await shot("subagents-expanded");
  await dumpPage(page, "s60 subagents expanded");
  await expectBody(page, /explorer/, "explorer subagent row after finish", 10_000);
  await expectBody(page, /builder/, "builder subagent row after finish", 10_000);
  await expectBody(page, /greet\(\) is defined in src\/greeting\.ts and is not called anywhere else/, "explorer result summary (task_notification)", 10_000);
  await expectBody(page, /The build script runs tsc\./, "builder result summary (task_notification)", 10_000);
  await expectBody(page, /Previous agents \(2\)/, "Lineage panel keeps both finished children", 10_000);
  await page.getByText(/^Previous agents/).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await shot("lineage-previous-agents");
  // open the explorer's own thread (child thread = Claude Agent subagent transcript projected by T3)
  await page.getByText(/^explorer$/).first().click();
  await page.waitForTimeout(2500);
  await shot("child-thread");
  await dumpPage(page, "s60 child thread");
  await expectBody(page, /Subagent of/, "child thread header names its parent", 15_000);
  await expectBody(page, /greeting\.ts/, "child thread shows the child's own Read of greeting.ts", 10_000);
  await expectBody(page, /not called anywhere else/, "child thread shows the child's final text", 10_000);
}
