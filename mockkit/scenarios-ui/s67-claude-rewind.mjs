// S67 rewind (Claude): T3 "Edit from here" rolls the thread back. For Claude it closes the CLI and respawns it with `--resume=<id>
// --resume-session-at=<assistant uuid of the kept turn>` (ClaudeAdapterV2.rollbackThread + resolveClaudeRollbackResumeSessionAt). The mock honours the
// cursor (drops later turns from the persisted session), so after the revert the next answer counts "turn 3" again and quotes the kept turn.
// Proof = the UI text AND a `--resume-session-at` argv line in the launcher's probes.log. (T3 itself refuses "Revert files too" in a shared workspace.)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composerEditor, dumpPage, expectBody, expectText, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";
import { finding, must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s67 is Claude-specific (--resume-session-at rewind); skipped for other providers");
  await startSession(page, env);
  for (const [i, q] of ["First question: what is greet()?", "Second question: where is it used?", "Third message, to be rolled back."].entries()) {
    await sendPrompt(page, q);
    await expectText(page, new RegExp(`Mock agent, turn ${i + 1}`), `turn ${i + 1} answer`, 60_000);
    await page.waitForTimeout(1200);
  }
  await shot("before-revert");
  await page.getByText("Third message, to be rolled back.").first().hover();
  await page.waitForTimeout(600);
  const edit = await must(page, page.getByRole("button", { name: "Edit from here" }).last(), "Edit from here button", 20_000);
  await shot("hover-edit-from-here");
  await edit.click();
  await page.waitForTimeout(1200);
  await shot("confirm-dialog");
  await dumpPage(page, "s67 confirm dialog");
  await page.getByRole("button", { name: /Revert and keep changes|Revert|Confirm|Continue/i }).last().click();
  await page.waitForFunction(() => !document.body.innerText.includes("Mock agent, turn 3"), null, { timeout: 60_000 }).catch(() => console.log("FINDING: turn 3 text still visible after revert"));
  await page.waitForTimeout(2500);
  await shot("after-revert");
  const after = await dumpPage(page, "s67 after revert");
  await finding("timeline after revert", () => `turn3Gone=${!/Mock agent, turn 3/.test(after.text)} turn2Kept=${/Mock agent, turn 2/.test(after.text)}`);
  // continue: the reverted prompt was put back into the composer; clear it first
  await composerEditor(page).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await sendPrompt(page, "Fresh message after the revert.");
  await expectBody(page, /Mock agent, turn 3\. You said: "Fresh message after the revert\."/, "turn counter continues from the kept turn (turn 3 again), i.e. the CLI honoured --resume-session-at", 60_000);
  await expectBody(page, /Your previous message was: "Second question: where is it used\?"/, "the answer quotes the kept turn 2 as the previous message (rolled-back turn 3 is gone from the session)", 20_000);
  await page.waitForTimeout(1500);
  await shot("continued");
  const probes = readFileSync(join(env.MOCK_CONTROL_DIR, "probes.log"), "utf8");
  const cursors = probes.split("\n").filter((l) => /--resume-session-at/.test(l));
  console.log(`FINDING launcher lines with --resume-session-at: ${cursors.length}\n${cursors.map((l) => l.slice(0, 200)).join("\n")}`);
  if (cursors.length === 0) throw new Error("T3 never respawned the CLI with --resume-session-at (rollback did not reach the Claude process)");
}
