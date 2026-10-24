// S74 subagents over the newer `subAgentActivity` protocol (Codex): started/completed activity items whose agentPath ("/root/explorer")
// titles the subagent in T3 (the older collabAgentToolCall form, S52, has no title: rows read plain "Subagent"), plus per-child
// thread/settings/updated (model gpt-6-luna, effort low) and model/rerouted (the builder is rerouted to gpt-5.6-sol; T3 only consumes both
// for subagents). Hold gate `sub74` pins the first child mid-run. Codex flavor only.
import { ask, bodyText, dumpPage, expandRows, expandWork, expectText, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "subagent-activity", "Map greet() usage and check the build script in parallel.", { hold: "sub74" });
  await waitReached("sub74", 60_000, env);
  await page.waitForTimeout(2500);
  const running = await dumpPage(page, "s74 child running");
  const rt = running.text;
  console.log(`FINDING while the first child runs: rowTitle(explorer)=${/explorer/i.test(rt)} agentPath=${/\/root\/explorer/.test(rt)} subagentRow=${/Subagent/.test(rt)} model=${/gpt-6-luna|GPT-6-Luna/i.test(rt)} effort=${/\blow\b/i.test(rt)}`);
  await shot("child-running");
  release("sub74", env);
  await expectText(page, /Both subagents reported back/, "parent's closing sentence after both subagents finished", 90_000);
  await page.waitForTimeout(2500);
  await expandWork(page);
  await expandRows(page, { type: "subagent" });
  await page.waitForTimeout(1000);
  const done = await dumpPage(page, "s74 finished");
  const t = await bodyText(page);
  console.log(`FINDING after finish: explorerTitle=${/explorer/i.test(t)} builderTitle=${/builder/i.test(t)} agentPaths=${/\/root\/(explorer|builder)/.test(t)} gpt-5.6-sol=${/gpt-5\.6-sol|GPT-5\.6-Sol/i.test(t)} gpt-6-luna=${/gpt-6-luna|GPT-6-Luna/i.test(t)} resultShown=${/nothing else calls it/.test(t)} summaryRow=${JSON.stringify(t.match(/\d+ subagents?/)?.[0] ?? null)}`);
  await shot("finished");
  const summary = page.getByText(/\d+ subagents?/).first();
  if (await summary.isVisible().catch(() => false)) {
    await summary.click().catch(() => {});
    await page.waitForTimeout(1500);
    await shot("subagents-expanded");
    await dumpPage(page, "s74 subagents expanded");
  }
  const child = page.getByText(/\/root\/explorer|explorer/i).first();
  if (await child.isVisible().catch(() => false)) {
    await child.click().catch(() => {});
    await page.waitForTimeout(2500);
    await shot("child-thread");
    const c = await dumpPage(page, "s74 child thread");
    console.log(`FINDING child thread: title=${JSON.stringify(c.title)} parentLink=${/Subagent of|Open parent/.test(c.text)} reply=${/nothing else calls it/.test(c.text)}`);
  } else console.log("FINDING: no explorer row to open the child thread from");
  void done;
}
