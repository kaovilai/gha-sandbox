// S53 thread goal (Codex thread/goal/*). `/goal <objective>` in the composer sets a goal, T3 shows the
// goal banner (Pursuing goal / Goal complete, tokens used, Clear / Resume). The turn is held so the active state is captured,
// then released; the scenario marks the goal complete. Finally `/goal clear` (the banner's Clear button) removes it.
// Grok flavor: T3 only owns /goal for Codex, so this driver is only meaningful with MOCKKIT_PROVIDER=codex.
import { composerEditor, dumpPage, nextScenario, sendPrompt, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  nextScenario(env, "goal-work", { hold: "goal" });
  await sendPrompt(page, "/goal Make the greeting helper friendlier");
  await page.waitForTimeout(1500);
  // a slash-command popup may swallow the first Enter: send again if the text is still in the composer
  const left = (await composerEditor(page).innerText().catch(() => "")) ?? "";
  if (/\/goal/.test(left)) {
    console.log(`FINDING first Enter did not send; composer still holds ${JSON.stringify(left.slice(0, 60))}`);
    await shot("slash-menu");
    await page.keyboard.press("Enter");
  }
  await waitReached("goal", 60_000, env).catch(async (e) => {
    await dumpPage(page, "s53 hold never reached");
    throw e;
  });
  await page.waitForTimeout(2000);
  const active = await dumpPage(page, "s53 goal active");
  console.log(`FINDING active banner: pursuing=${/Pursuing goal/.test(active.text)} set=${/Goal set/.test(active.text)} objective=${/friendlier/.test(active.text)}`);
  await shot("goal-active");
  release("goal", env);
  await page.getByText(/the goal is met/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  const done = await dumpPage(page, "s53 goal complete");
  console.log(`FINDING complete banner: ${/Goal complete/.test(done.text)} tokens=${JSON.stringify(done.text.match(/[\d.,]+k? tokens/)?.[0] ?? null)}`);
  await shot("goal-complete");
  const clear = page.getByRole("button", { name: /^Clear$/ }).first();
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    await page.waitForTimeout(2500);
    await shot("goal-cleared");
    await dumpPage(page, "s53 after clear");
  } else {
    console.log("FINDING: no Clear button on the goal banner");
  }
}
