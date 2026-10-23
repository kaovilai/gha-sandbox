import { S } from "../lib/ir.mjs";

// MCP elicitation (Codex mcpServer/elicitation/request): an MCP connector asks the user before a tool runs.
// T3 shows an "App access approval" card (Cancel / Decline / Always allow this session / Always allow / Approve).
// Other adapters degrade to a plain permission request.
export default {
  id: "mcp-elicit",
  title: "MCP app access request",
  steps: () => [
    S.say("I'll check the open bugs in Linear first. The connector needs your approval.\n\n"),
    S.elicit({
      server: "linear",
      appName: "Linear",
      message: 'Allow Linear to run the tool "search_issues"?',
      onAccept: [
        S.tool({ kind: "other", title: "linear.search_issues", server: "linear", name: "search_issues", input: { query: "is:open label:bug" }, output: "MOCK-12 Crash on startup\nMOCK-15 Slow search results" }),
        S.say("\nFound 2 open bugs: MOCK-12 (crash on startup) and MOCK-15 (slow search)."),
      ],
      onDecline: [S.say("\nUnderstood, I will not query Linear.")],
    }),
  ],
};
