// S66 /compact (Claude): two turns, then the `/compact` standalone command. The CLI answers status:compacting (T3 "Compacting context" row,
// pinned with a hold gate), status {compact_result:success} + compact_boundary {pre_tokens, post_tokens} (T3 "Context compacted" with before/after
// counts), a synthetic summary message and a `result` with local_command:"compact". The context meter drops to the post-compaction size.
// Phase 2: `compact-auto` = auto-compaction inside a turn (trigger "auto", 168k -> 4.2k tokens) and the model continues.
import { ask, bodyText, composerEditor, dumpPage, expandRows, expandWork, expectBody, expectText, nextScenario, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s66 is Claude-specific (/compact frames); skipped for other providers");
  await startSession(page, env);
  await sendPrompt(page, "First question: what is greet()?");
  await expectText(page, /Mock agent, turn 1/, "turn 1 answer", 60_000);
  await page.waitForTimeout(800);
  await sendPrompt(page, "Second question: where is it used?");
  await expectText(page, /Mock agent, turn 2/, "turn 2 answer", 60_000);
  await page.waitForTimeout(1500);
  await shot("before-compact");
  await finding("context meter before compaction", async () => JSON.stringify((await bodyText(page)).match(/\d+(\.\d+)?k?\s*\/\s*\d+k?|\d+%[^\n]{0,30}/)?.[0] ?? null));
  // hidden routing for the pinned run: the queue entry only carries the hold gate, the text sent is the bare "/compact"
  nextScenario(env, "compact", { hold: "cmp66" });
  const ed = composerEditor(page);
  await ed.click();
  await ed.pressSequentially("/compact", { delay: 40 });
  await page.waitForTimeout(800);
  await shot("compact-typed");
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Enter");
  await waitReached("cmp66", 60_000, env);
  await page.waitForTimeout(2500);
  const running = await dumpPage(page, "s66 compacting");
  await expectBody(page, /Compacting context/i, "pinned running row while the CLI reports status compacting", 10_000);
  await shot("compacting");
  release("cmp66", env);
  await expectBody(page, /Context compacted/i, "'Context compacted' row after compact_boundary", 60_000);
  await page.waitForTimeout(2500);
  await expandWork(page);
  await expandRows(page, { type: "compaction" });
  await page.waitForTimeout(800);
  const done = await dumpPage(page, "s66 compacted");
  // observed (T3 e01c399): a divider row "Context compacted 24K -> 1.19K tokens" built from compact_metadata pre/post_tokens
  await expectBody(page, /Context compacted\s*24K[\s→>-]*1\.19K tokens/, "compaction divider shows the before/after token counts from compact_boundary", 10_000);
  await shot("compacted");
  await finding("context meter after compaction", async () => JSON.stringify((await bodyText(page)).match(/\d+(\.\d+)?k?\s*\/\s*\d+k?|\d+%[^\n]{0,30}/)?.[0] ?? null));
  // the thread keeps working and counts from the compacted context
  await sendPrompt(page, "Third question after compaction.");
  await expectText(page, /Mock agent, turn 3/, "turn 3 answer after /compact (compaction is not a turn)", 60_000);
  await page.waitForTimeout(1200);
  await shot("after-compact-turn");
  // auto-compaction in the middle of a turn
  await ask(page, env, "compact-auto", "Do the long task.");
  await expectText(page, /continuing with the remaining edits/, "answer after the mid-turn auto-compaction", 60_000);
  await page.waitForTimeout(2000);
  await expandWork(page);
  await expandRows(page, { type: "compaction" });
  const auto = await dumpPage(page, "s66 auto compaction");
  await expectBody(page, /Context compacted\s*168K[\s→>-]*4\.20K tokens/, "mid-turn auto-compaction divider (trigger auto, 168K -> 4.20K)", 10_000);
  await shot("auto-compacted");
}
