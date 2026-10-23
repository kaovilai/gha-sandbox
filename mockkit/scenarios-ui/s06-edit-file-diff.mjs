// S06 edit-file-diff: the mock REALLY writes src/greeting.ts + src/farewell.ts in the session cwd, then we
// open the Changes/Diff panel. The app's Changes/checkpoint DOES see these external edits (header "+5 -1",
// diff lists both files), so real fs writes give a real diff. The workspace files are checked on disk too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, bodyText, dumpPage, expandWork, expectBody, expectText, expectVisible, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "edit-file-diff", "Update the greeting helper.");
  await page.getByText(/Open the diff panel/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  // on disk: the mock really wrote both files
  const greet = readFileSync(join(env.MOCKKIT_WS, "src/greeting.ts"), "utf8");
  const farewell = readFileSync(join(env.MOCKKIT_WS, "src/farewell.ts"), "utf8");
  if (!/Welcome aboard/.test(greet) || !/Goodbye/.test(farewell)) throw new Error("assertion failed: workspace files were not written by the mock agent");
  await expandWork(page);
  await expectText(page, /2 changed files/, "'2 changed files' card in the timeline");
  await shot("timeline");

  const changes = page.getByRole("button", { name: /Changes/ }).first();
  const label = (await changes.textContent().catch(() => null))?.trim() ?? "";
  console.log(`FINDING header Changes button text: ${JSON.stringify(label)}`);
  if (!/\+5\s*-1/.test(label)) throw new Error(`assertion failed: header Changes counter should read +5 -1, got ${JSON.stringify(label)}`);
  await changes.click();
  await page.waitForTimeout(2000);
  await shot("diff-panel");
  // the Diff panel lists both files; farewell.ts (new file) shows its added lines
  // (the Diff panel renders in shadow DOM: text locators pierce it, body.innerText does not)
  await expectText(page, "src/farewell.ts", "diff panel row src/farewell.ts");
  await expectText(page, "src/greeting.ts", "diff panel row src/greeting.ts");
  await expectText(page, /Goodbye/, "farewell.ts hunk content ('Goodbye') in the diff");
  // expand the file rows to show the actual hunks (row chevron, not the filename: filename opens the file viewer)
  const chevrons = page.locator("button[aria-label^='Expand'], button[aria-label*='xpand file']");
  console.log(`FINDING expand controls in diff panel: ${await chevrons.count()}`);
  await page.getByRole("button", { name: /Expand all|Toggle diff/i }).first().click().catch(() => {});
  await page.mouse.click(917, 107).catch(() => {}); // chevron of first file row
  await page.waitForTimeout(800);
  // greeting.ts is collapsed by default: open it through its row (text pierces the diff's shadow DOM)
  if (!(await page.getByText(/Welcome aboard/).first().isVisible().catch(() => false))) {
    await page.getByText("src/greeting.ts", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(800);
  }
  const welcome = await page.getByText(/Welcome aboard/).first().isVisible().catch(() => false);
  console.log(`FINDING greeting.ts hunk expanded ('Welcome aboard' visible): ${welcome}`);
  await page.waitForTimeout(700);
  await shot("diff-expanded");
  const info = await dumpPage(page, "s06 diff panel");
  console.log(`FINDING diff mentions greeting.ts: ${/greeting\.ts/.test(info.text)} farewell.ts: ${/farewell\.ts/.test(info.text)} welcome-line: ${/Welcome aboard/.test(await bodyText(page))}`);
}
