// S54 thread revert / rollback (Codex thread/turns/list + thread/revert): three turns, the second one writes files
// (edit-file-diff). Hover the third user message, click "Edit from here" (Undo), confirm in the dialog (with and without
// restoring files). T3 asks the provider to roll the conversation back; the mock drops the turns and the timeline follows.
import { ask, composerEditor, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "First question: what is greet()?");
  await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await ask(page, env, "edit-file-diff", "Update the greeting helper.");
  await page.getByText(/Open the diff panel/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await ask(page, env, "echo", "Third message, to be rolled back.");
  await page.getByText(/turn 3/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  await shot("before-revert");
  const info = await dumpPage(page, "s54 before revert");
  console.log(`FINDING before: turn3=${/turn 3/.test(info.text)} changes=${JSON.stringify(info.text.match(/\+\d+ -\d+/)?.[0] ?? null)}`);
  // hover the 3rd user message so its actions show, then "Edit from here"
  const msg = page.getByText("Third message, to be rolled back.").first();
  await msg.hover();
  await page.waitForTimeout(600);
  const edit = await must(page, page.getByRole("button", { name: "Edit from here" }).last(), "Edit from here button", 20_000);
  await shot("hover-edit-from-here");
  await edit.click();
  await page.waitForTimeout(1200);
  await shot("confirm-dialog");
  await dumpPage(page, "s54 confirm dialog");
  const confirm = page.getByRole("button", { name: /Revert|Edit from here|Confirm|Continue|Restore/i }).last();
  await confirm.click();
  // the 3rd turn must disappear from the timeline
  await page.waitForFunction(() => !document.body.innerText.includes("Mock agent, turn 3"), null, { timeout: 60_000 }).catch(() => console.log("FINDING: turn 3 text still visible after revert"));
  await page.waitForTimeout(2500);
  await shot("after-revert");
  const after = await dumpPage(page, "s54 after revert");
  console.log(`FINDING after: turn3 gone=${!/Mock agent, turn 3/.test(after.text)} turn2-still-there=${/Open the diff panel/.test(after.text)}`);
  // continue the thread: the mock restarts counting from the reverted history (turn 3 again). The reverted prompt was put
  // back into the composer, so clear it first.
  await composerEditor(page).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await ask(page, env, "echo", "Fresh message after the revert.");
  await page.getByText(/Fresh message after the revert/).first().waitFor({ timeout: 60_000 });
  await page.getByText(/turn 3/).first().waitFor({ timeout: 60_000 }).catch(() => console.log("FINDING: no 'turn 3' after revert (history not rolled back?)"));
  await page.waitForTimeout(1500);
  await shot("continued");
  // second revert on the edit turn. First "Revert files too": T3 itself refuses it unless the thread has an isolated worktree
  // (T3 behaviour, not the mock: "File restore requires an isolated worktree"), the error banner is captured. Then
  // "Revert and keep changes" rolls the conversation back past the edit turn (Codex thread/revert with 2 turns), files stay.
  await page.getByText("Update the greeting helper.").first().hover();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Edit from here" }).nth(1).click();
  await page.waitForTimeout(1200);
  await shot("confirm-dialog-revert-files");
  await page.getByRole("button", { name: /^Revert files too$/ }).click();
  await page.waitForTimeout(3000);
  const refused = await dumpPage(page, "s54 revert files too");
  console.log(`FINDING Revert files too refused by T3 (shared workspace): ${/isolated worktree/.test(refused.text)}`);
  await shot("revert-files-refused-by-t3");
  await page.getByRole("button", { name: /Dismiss|Close/i }).first().click().catch(() => {});
  await page.getByText("Update the greeting helper.").first().hover();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Edit from here" }).nth(1).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Revert and keep changes$/ }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Open the diff panel"), null, { timeout: 60_000 }).catch(() => console.log("FINDING: edit turn still visible after the second revert"));
  await page.waitForTimeout(3000);
  await shot("after-second-revert");
  const fin = await dumpPage(page, "s54 after second revert");
  console.log(`FINDING after second revert: editTurnGone=${!/Open the diff panel/.test(fin.text)} firstTurnKept=${/turn 1/.test(fin.text)} changes=${JSON.stringify(fin.text.match(/Changes\s*\+\d+\s*-\d+/)?.[0] ?? null)}`);
}
