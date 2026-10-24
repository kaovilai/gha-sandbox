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
  await finding("banner for the persistent Monitor", () => `banner=${/Running: [^\n]*Watch the dev server/.test(running.text)} anyRunningText=${JSON.stringify(running.text.match(/Running[^\n]{0,80}/)?.[0] ?? null)}`);
  await shot("monitor-running");
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(800);
  await shot("monitor-row");
  await finding("Monitor tool row", async () => `monitor=${/Monitor/i.test(await bodyText(page))}`);
  release("bg62", env);
  await expectBody(page, /Watch the dev server finished \(exit 0\)\. Last line: dev server listening/, "wake-turn reply reporting the finished monitor", 60_000);
  await page.waitForTimeout(5000);
  await shot("monitor-finished");
  const fin = await dumpPage(page, "s62 finished");
  await finding("Monitor finished row / banner after completion", () => `finishedRow=${/Monitor "Watch the dev server" (finished|stream ended)/.test(fin.text)} bannerStill=${/Running: [^\n]*Watch the dev server/.test(fin.text)}`);
  if (/Running: [^\n]*Watch the dev server/.test(fin.text)) {
    await page.getByRole("button", { name: /^Stop$/ }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
    await shot("banner-after-stop");
    await finding("banner cleared by Stop", async () => !/Running: [^\n]*Watch the dev server/.test(await bodyText(page)));
  }
}
