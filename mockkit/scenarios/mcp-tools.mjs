import { S } from "../lib/ir.mjs";

// MCP tool calls (Claude `mcp__<server>__<tool>` tool_use + tool_use_meta {display_name, server_display_name}; T3 renders a dynamic tool row
// titled with the display name and tagged with the server). Codex shows the same calls as mcpToolCall items; ACP as plain tool calls.
export default {
  id: "mcp-tools",
  title: "MCP tool calls",
  steps: () => [
    S.say("Querying the Linear and Docs MCP servers.\n\n"),
    S.tool({
      kind: "other",
      title: "Linear list issues",
      server: "linear",
      name: "list_issues",
      display: "List issues",
      serverDisplay: "Linear",
      input: { team: "MOCK", state: "open" },
      output: JSON.stringify({ issues: [{ id: "MOCK-12", title: "Crash on startup" }, { id: "MOCK-15", title: "Slow search results" }] }),
    }),
    S.tool({
      kind: "other",
      title: "Docs search",
      server: "docs",
      name: "search_docs",
      display: "Search docs",
      serverDisplay: "Docs",
      input: { query: "startup crash" },
      output: JSON.stringify({ hits: [{ title: "Troubleshooting startup", url: "https://docs.example.invalid/startup" }] }),
    }),
    S.say("Linear has 2 open issues (MOCK-12 crash on startup, MOCK-15 slow search) and the docs have a startup troubleshooting page."),
  ],
};
