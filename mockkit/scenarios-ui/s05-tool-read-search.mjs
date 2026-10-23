// S05 tool-read/search: read + search tool rows in the work log (real file reads from the workspace).
import { ask, bodyText, dumpPage, expandWork, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "tool-read", "What does this project do?");
  await page.getByText(/tiny TypeScript package/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  await shot("collapsed");
  await expandWork(page);
  // the work log summarises exactly the three mock calls: Grok groups them, Codex counts commands
  const codex = providerOf(env) === "codex";
  const summary = codex ? /Ran 3 commands/ : /Read 2 files and searched code 1 time/;
  await expectText(page, summary, `work-log summary ${summary}`);
  await shot("expanded");
  // open the group to list the individual calls
  const group = page.getByRole("button", { name: summary }).first();
  if (await group.isVisible().catch(() => false)) await group.click().catch(() => {});
  await page.waitForTimeout(1000);
  if (codex) {
    console.log(`FINDING codex rows listed after expanding: README=${/README\.md/.test(await bodyText(page))}`);
  } else {
    await expectBody(page, /Read [^\n]*README\.md/, "tool row 'Read ... README.md'");
    await expectBody(page, /Read [^\n]*package\.json/, "tool row 'Read ... package.json'");
    await expectBody(page, /Searched [^\n]*greet/, "tool row 'Searched greet ...'");
  }
  await shot("tools");
  await dumpPage(page, "s05");
}
