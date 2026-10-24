// S64 MCP tool calls (Claude): `mcp__linear__list_issues` / `mcp__docs__search_docs` tool_use blocks with tool_use_meta {display_name, server_display_name}
// (T3 -> dynamic tool row titled with the display name + a server source badge). The init frame lists the servers (mcp_servers) and
// `mcp_status` answers connected: T3 does not render MCP server status for Claude (recorded, not asserted).
import { ask, bodyText, dumpPage, expandRows, expandWork, expectBody, expectNoText, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s64 is Claude-specific (mcp__ tool rows); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "mcp-tools", "What issues are open in Linear and do the docs mention the crash?");
  await expectText(page, /Linear has 2 open issues/, "final answer after both MCP tool calls", 60_000);
  await page.waitForTimeout(1500);
  await shot("answer");
  await expandWork(page);
  await expectBody(page, /Used Linear and Docs integrations/, "grouped MCP row names both servers (from tool_use_meta server_display_name)", 20_000);
  await page.getByText(/^Used Linear and Docs integrations/).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(1000);
  await dumpPage(page, "s64 mcp rows");
  // observed (T3 e01c399): rows are titled by tool_use_meta display_name ("List issues" / "Search docs"), the group row names the servers
  await expectBody(page, /List issues/, "MCP row titled with display_name 'List issues'", 10_000);
  await expectBody(page, /Search docs/, "MCP row titled with display_name 'Search docs'", 10_000);
  await expectBody(page, /MOCK-12/, "expanded MCP row shows the tool result JSON", 10_000);
  await expectNoText(page, /mcp__linear__|mcp__docs__/, "raw mcp__server__tool names are not shown");
  await shot("work-log");
}
