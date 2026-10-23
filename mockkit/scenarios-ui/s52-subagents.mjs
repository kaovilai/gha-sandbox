// S52 subagents (Codex): collabAgentToolCall spawnAgent -> child thread. Shows the running subagent row while the first
// worker is held mid-run, the finished rows, and the child thread opened from its row. T3 may render the rows differently
// than expected; the driver logs what it finds (FINDING lines) and dumps the DOM at each state.
// Grok flavor: each spawn degrades to one tool call.
import { ask, dumpPage, expandRows, expandWork, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "subagent-spawn", "Map greet() usage and check the build script in parallel.", { hold: "sub" });
  await waitReached("sub", 60_000, env);
  await page.waitForTimeout(2500);
  const running = await dumpPage(page, "s52 child running");
  console.log(`FINDING subagent visible while running: explorer=${/explorer/i.test(running.text)} prompt=${/Find where greet/.test(running.text)}`);
  await shot("child-running");
  release("sub", env);
  await page.getByText(/Both workers finished/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2000);
  await expandWork(page);
  await expandRows(page, { type: "subagent" });
  const done = await dumpPage(page, "s52 finished");
  console.log(`FINDING after finish: explorer=${/explorer/i.test(done.text)} builder=${/builder/i.test(done.text)} result text shown=${/not called anywhere else/.test(done.text)}`);
  await shot("finished");
  // open the child thread (subagent row link / sidebar child thread)
  const open = page.getByRole("button", { name: /Open (child )?thread|View (child )?thread|explorer/i }).first();
  if (await open.isVisible().catch(() => false)) {
    await open.click().catch(() => {});
    await page.waitForTimeout(2500);
    await shot("child-thread");
    await dumpPage(page, "s52 child thread");
  } else {
    console.log("FINDING: no obvious control to open the child thread");
  }
}
