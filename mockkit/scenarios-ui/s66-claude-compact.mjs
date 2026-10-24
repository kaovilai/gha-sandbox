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
  await finding("compaction running row", () => `compacting=${/Compacting context|Compacting/i.test(running.text)}`);
  await shot("compacting");
  release("cmp66", env);
  await expectBody(page, /Context compacted/i, "'Context compacted' row after compact_boundary", 60_000);
  await page.waitForTimeout(2500);
  await expandWork(page);
  await expandRows(page, { type: "compaction" });
  await page.waitForTimeout(800);
  const done = await dumpPage(page, "s66 compacted");
  await finding("compaction row details (before/after tokens)", () => `before=${/24[.,]?0*k?|24,000|24000/.test(done.text)} after=${/1[.,]192|1\.2k|1192/.test(done.text)} text=${JSON.stringify(done.text.match(/Context compacted[^\n]{0,80}/)?.[0] ?? null)}`);
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
  await finding("auto-compaction row (168k -> 4.2k)", () => `compactedRows=${(auto.text.match(/Context compacted/g) ?? []).length} 168=${/168k|168,000|168000/.test(auto.text)} 4_2=${/4\.2k|4,200|4200/.test(auto.text)}`);
  await shot("auto-compacted");
}
