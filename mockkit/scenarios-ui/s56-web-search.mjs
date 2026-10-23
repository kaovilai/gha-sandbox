// S56 web-search + commentary (Codex webSearch item, agentMessage phase "commentary" then "final_answer"). T3 renders the
// search as a work-log row; the commentary line appears before the final answer. Grok flavor: search = a fetch tool call.
import { ask, dumpPage, expandRows, expandWork, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "web-search", "What are the Vite config defaults?");
  await page.getByText(/build\.outDir/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("answer");
  await expandWork(page);
  await expandRows(page, { type: "web" });
  await page.waitForTimeout(800);
  const info = await dumpPage(page, "s56 web search");
  console.log(`FINDING web search row: query=${/vite 8 config options/i.test(info.text)} commentary text=${/look that up/.test(info.text)}`);
  await shot("work-log");
}
