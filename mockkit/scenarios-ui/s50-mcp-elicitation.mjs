// S50 mcp-elicitation (Codex): the MCP connector asks before a tool runs (mcpServer/elicitation/request). T3 shows an
// "App access approval" card with the connector name and Cancel / Decline / Always allow / Approve. Approve once (tool runs),
// then a second request is declined (the agent acknowledges). Needs Supervised mode (Full access never asks).
// With the Grok flavor the same scenario degrades to a plain permission request (Approve / Decline).
import { ask, dumpPage, setRuntimeMode, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await ask(page, env, "mcp-elicit", "Check the open bugs in Linear.");
  await must(page, page.getByRole("button", { name: /^Approve$/ }), "Approve button (MCP elicitation card)", 60_000);
  await page.waitForTimeout(800);
  const info = await dumpPage(page, "s50 pending");
  console.log(`FINDING app-access card: ${/App access approval/.test(info.text)} connector name shown: ${/Linear/.test(info.text)} persist options: ${JSON.stringify(["Always allow", "this session", "Decline", "Cancel"].filter((t) => info.text.includes(t)))}`);
  await shot("pending");
  await page.getByRole("button", { name: /^Approve$/ }).first().click();
  await page.getByText(/Found 2 open bugs/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("approved-tool-ran");
  // second request: decline
  await ask(page, env, "mcp-elicit", "Try the Linear lookup again.");
  const decline = await must(page, page.getByRole("button", { name: /^Decline$/ }), "Decline button", 60_000);
  await page.waitForTimeout(800);
  await shot("second-pending");
  await decline.click();
  await page.getByText(/I will not query Linear/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("declined");
  await dumpPage(page, "s50 declined");
}
