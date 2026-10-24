// S75 raw reasoning (Codex item/reasoning/textDelta -> reasoning `content`): a summarized reasoning block followed by raw reasoning text,
// then the answer. T3 appends raw deltas to the same reasoning projection as summaries (separate parts). Codex flavor only.
import { ask, bodyText, dumpPage, expandRows, expandWork, expectText, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "raw-reasoning", "Should the tree walk be recursive or iterative?");
  await expectText(page, /I'll walk the tree iteratively with an explicit stack/, "assistant answer after the reasoning", 90_000);
  await page.waitForTimeout(1500);
  await shot("answer");
  await expandWork(page);
  await expandRows(page, { type: "reasoning" });
  // the collapsed group row reads "Thought (x2)": one summary + one raw block
  const grp = page.getByText(/^Thought/).first();
  if (await grp.isVisible().catch(() => false)) {
    await grp.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  await expandRows(page, {});
  await page.waitForTimeout(1200);
  await dumpPage(page, "s75 reasoning expanded");
  const t = await bodyText(page);
  console.log(`FINDING reasoning text: summary=${/weigh a recursive walk/.test(t)} raw=${/explicit stack keeps memory flat/.test(t)} rawMarker=${/RAW>/.test(t)}`);
  await shot("reasoning-expanded");
}
