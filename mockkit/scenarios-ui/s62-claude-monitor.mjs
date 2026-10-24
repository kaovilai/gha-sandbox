// S62 Monitor (Claude): the `Monitor` tool starts a persistent watcher (local_bash task + Monitor tool row); the turn ends, T3 shows the
// background-work banner; releasing the gate reports `Monitor "..." stream ended` and the CLI's wake turn. Same `background-task` scenario as S28 (Grok).
import { ask, bodyText, dumpPage, expandRows, expandWork, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s62 is Claude-specific (Monitor frames); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "background-task", "Watch the dev server in the background.", { until: "bg62" });
  await expectText(page, /The dev server is running in the background\./, "assistant closing sentence of the turn", 60_000);
  await waitReached("bg62", 60_000, env);
  await page.waitForTimeout(2500);
  const running = await dumpPage(page, "s62 monitor running");
  // observed: a persistent Monitor shows a composer banner "<description>" + Stop (no "Running:" prefix, unlike a Bash background task)
  if (!(await page.getByRole("button", { name: /^Stop$/ }).first().isVisible().catch(() => false))) throw new Error("assertion failed: no background-work banner (Stop button) while the persistent Monitor runs");
  await finding("banner text for the persistent Monitor", () => JSON.stringify(running.text.match(/\n(Watch the dev server)\nStop/)?.[1] ?? running.text.match(/Running[^\n]{0,80}/)?.[0] ?? null));
  await shot("monitor-running");
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(800);
  await shot("monitor-row");
  await expectBody(page, /Monitor/i, "Monitor tool row", 10_000);
  release("bg62", env);
  await expectBody(page, /Watch the dev server finished \(exit 0\)\. Last line: dev server listening/, "wake-turn reply reporting the finished monitor", 60_000);
  await page.waitForTimeout(5000);
  await shot("monitor-finished");
  const fin = await dumpPage(page, "s62 finished");
  await expectBody(page, /Monitor "Watch the dev server" (finished|stream ended)/, "Monitor finished row after the notification", 10_000);
  if ((await page.getByRole("button", { name: /^Stop$/ }).count()) > 0) throw new Error("assertion failed: Stop banner still visible after the Monitor ended");
}
