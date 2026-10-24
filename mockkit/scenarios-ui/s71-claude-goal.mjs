// S71 /goal (Claude): Claude reports a goal only through the transcript (synthetic assistant lines "Goal set: X" / "Goal active: X (N turns)" /
// "Goal cleared: X", plus "Stop hook feedback" user frames); T3 (ClaudeAdapterV2.nextClaudeGoal) turns them into the thread goal. The turn is
// held so the active state can be captured; the scenario then completes the goal ("Goal cleared"). What T3 renders for it is recorded as FINDING lines.
import { composerEditor, dumpPage, expectText, nextScenario, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s71 is Claude-specific (/goal transcript lines); skipped for other providers");
  await startSession(page, env);
  nextScenario(env, "goal-work", { hold: "goal71" });
  await sendPrompt(page, "/goal Make the greeting helper friendlier");
  await page.waitForTimeout(1500);
  const left = (await composerEditor(page).innerText().catch(() => "")) ?? "";
  if (/\/goal/.test(left)) {
    console.log(`FINDING first Enter did not send; composer still holds ${JSON.stringify(left.slice(0, 60))}`);
    await shot("slash-menu");
    await page.keyboard.press("Enter");
  }
  await waitReached("goal71", 60_000, env);
  await page.waitForTimeout(2500);
  const active = await dumpPage(page, "s71 goal active");
  await finding("goal banner while active", () => `pursuing=${/Pursuing goal/.test(active.text)} goalSet=${/Goal set/.test(active.text)} objective=${/friendlier/.test(active.text)}`);
  await shot("goal-active");
  release("goal71", env);
  await expectText(page, /the goal is met/, "turn answer after the goal work", 60_000);
  await page.waitForTimeout(2500);
  const done = await dumpPage(page, "s71 goal done");
  await finding("goal banner after 'Goal cleared'", () => `pursuing=${/Pursuing goal/.test(done.text)} complete=${/Goal complete/.test(done.text)} cleared=${/Goal cleared/.test(done.text)}`);
  await shot("goal-done");
}
