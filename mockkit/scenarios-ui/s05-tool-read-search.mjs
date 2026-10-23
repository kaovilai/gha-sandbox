// S05 tool-read/search: read + search tool rows in the work log (real file reads from the workspace).
import { dumpPage, expandWork, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "[mock:tool-read] what does this project do?");
  await page.getByText(/tiny TypeScript package/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1000);
  await shot("collapsed");
  await expandWork(page);
  await shot("expanded");
  // open the grouped tool row ("Read 2 files and searched code 1 time") to list the individual calls
  await page.getByRole("button", { name: /Read 2 files/ }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await shot("tools");
  await dumpPage(page, "s05");
}
