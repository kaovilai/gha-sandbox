// S64 MCP tool calls (Claude): `mcp__linear__list_issues` / `mcp__docs__search_docs` tool_use blocks with tool_use_meta {display_name, server_display_name}
// (T3 -> dynamic tool row titled with the display name + a server source badge). The init frame lists the servers (mcp_servers) and
// `mcp_status` answers connected: T3 does not render MCP server status for Claude (recorded, not asserted).
import { ask, bodyText, dumpPage, expandRows, expandWork, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s64 is Claude-specific (mcp__ tool rows); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "mcp-tools", "What issues are open in Linear and do the docs mention the crash?");
  await expectText(page, /Linear has 2 open issues/, "final answer after both MCP tool calls", 60_000);
  await page.waitForTimeout(1500);
  await shot("answer");
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(1000);
  const info = await dumpPage(page, "s64 mcp rows");
  await finding("MCP rows (display names / servers / raw tool names)", () => `listIssues=${/List issues/.test(info.text)} searchDocs=${/Search docs/.test(info.text)} linear=${/Linear/.test(info.text)} docs=${/Docs/.test(info.text)} raw=${/mcp__/.test(info.text)}`);
  await finding("tool output visible after expand (MOCK-12)", async () => /MOCK-12/.test(await bodyText(page)));
  await shot("work-log");
}
