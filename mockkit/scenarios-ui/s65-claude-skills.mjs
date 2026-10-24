// S65 skills + slash-command execution (Claude): the workspace has .claude/skills/<name>/SKILL.md (seeded by the driver). T3 discovers them
// (`$` picker in the composer, "Skills" group), and a `$skill args` mention is sent as the text block `/name args`, which the CLI expands.
// The mock runs the `skill-run` scenario for it: `Skill` tool_use + Read of the SKILL.md + a closing answer. Fallback if the picker flow is not
// operable: typing `/release-notes v1.2` literally (same wire text).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyText, composerEditor, dumpPage, expandRows, expandWork, expectBody, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";

const SKILLS = {
  "release-notes": "---\nname: release-notes\ndescription: Draft release notes from the git log\n---\n\n# Release notes\n\nSummarize the commits since the last tag into user-facing notes.\n",
  "summarize-repo": "---\nname: summarize-repo\ndescription: Summarize the repository layout\n---\n\n# Summarize repo\n\nList the top-level folders and describe each in one line.\n",
};

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s65 is Claude-specific (skills / CLI slash commands); skipped for other providers");
  for (const [name, body] of Object.entries(SKILLS)) {
    mkdirSync(join(env.MOCKKIT_WS, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(env.MOCKKIT_WS, ".claude", "skills", name, "SKILL.md"), body);
  }
  await startSession(page, env);
  await page.waitForTimeout(4000); // workspace snapshot (skills + slash commands) lands
  const ed = composerEditor(page);
  await ed.click();
  await ed.pressSequentially("$", { delay: 40 });
  await page.waitForTimeout(1500);
  await shot("skill-menu");
  const menu = await dumpPage(page, "s65 $ menu");
  await finding("skills listed in the $ menu (unfiltered; machine-local personal skills may fill the first rows)", () => `releaseNotes=${/Release Notes/.test(menu.text)} summarizeRepo=${/Summarize Repo/.test(menu.text)}`);
  await ed.pressSequentially("release", { delay: 40 });
  await page.waitForTimeout(800);
  await shot("skill-menu-filtered");
  // observed: T3 title-cases the skill name ("Release Notes"), shows the SKILL.md description and a "Project Skill" badge
  await expectBody(page, /Release Notes/, "workspace skill listed in the $ picker (title-cased name)", 10_000);
  await expectBody(page, /Draft release notes from the/, "SKILL.md description shown in the $ picker", 10_000);
  await expectBody(page, /Project Skill/, "skill from <workspace>/.claude/skills is badged 'Project Skill'", 10_000);
  let usedPicker = false;
  try {
    await page.keyboard.press("Enter"); // select the highlighted skill -> chip
    await page.waitForTimeout(800);
    await ed.pressSequentially(" for version 1.2", { delay: 20 });
    await shot("skill-chip-typed");
    await page.keyboard.press("Enter");
    usedPicker = true;
  } catch (e) {
    console.log(`FINDING picker flow failed: ${e.message}`);
  }
  let ok = await page.getByText(/release-notes skill finished/).first().waitFor({ timeout: 25_000 }).then(() => true, () => false);
  if (!ok) {
    console.log("FINDING: picker flow did not execute the skill; falling back to the literal /release-notes text");
    await dumpPage(page, "s65 after picker flow");
    await ed.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
    await ed.pressSequentially("/release-notes for version 1.2", { delay: 20 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    usedPicker = false;
  }
  await expectBody(page, /release-notes skill finished: Draft release notes from the git log/, "closing answer of the executed skill (description read from SKILL.md)", 60_000);
  await page.waitForTimeout(1500);
  console.log(`FINDING skill invoked via the $ picker chip: ${usedPicker}`);
  // observed: the picker flow works (user bubble shows a "Release Notes" chip + "for version 1.2"); the literal-text fallback must not mask a broken picker
  if (!usedPicker) throw new Error("assertion failed: the $ picker flow did not execute the skill (only the literal /release-notes fallback did)");
  await expectBody(page, /Release Notes[\s\S]{0,40}for version 1\.2/, "user message carries the skill chip + args", 10_000);
  await shot("skill-done");
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(800);
  const info = await dumpPage(page, "s65 skill turn");
  await finding("skill rows (Skill tool, SKILL.md read, user message / chip)", async () => `skillRow=${/Skill/.test(info.text)} launching=${/Launching skill/.test(info.text)} skillMd=${/SKILL\.md/.test(info.text)} userText=${JSON.stringify((await bodyText(page)).match(/[^\n]*release-notes[^\n]*/)?.[0] ?? null)}`);
  await shot("skill-work-log");
}
