import { S } from "../lib/ir.mjs";

// MCP app (Codex mcpToolCall with mcpAppUi.resourceUri = ui://...; T3 reads the HTML via mcpServer/resource/read and renders it
// in a sandboxed frame in the timeline). Static HTML, no scripts. Other adapters show a plain tool call.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 14px; background: #f6f8fb; color: #1d2733; }
  h1 { font-size: 15px; margin: 0 0 10px; }
  .row { display: flex; align-items: center; gap: 10px; background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
  .id { font-weight: 600; width: 64px; }
  .tag { margin-left: auto; font-size: 12px; padding: 2px 8px; border-radius: 999px; }
  .bug { background: #fde2e2; color: #9b1c1c; } .perf { background: #fff1cc; color: #8a5a00; } .done { background: #d9f5e3; color: #17663a; }
</style></head><body>
  <h1>Linear: open issues (mock MCP app)</h1>
  <div class="row"><span class="id">MOCK-12</span>Crash on startup<span class="tag bug">bug</span></div>
  <div class="row"><span class="id">MOCK-15</span>Slow search results<span class="tag perf">perf</span></div>
  <div class="row"><span class="id">MOCK-18</span>Update README screenshots<span class="tag done">done</span></div>
</body></html>`;

export default {
  id: "mcp-app",
  title: "MCP app result",
  steps: () => [
    S.say("Pulling the issue board from Linear.\n\n"),
    S.mcpApp({ server: "linear", name: "issue_board", title: "linear.issue_board", input: { team: "MOCK" }, output: "3 issues (2 open)", html }),
    S.say("The board above shows 2 open issues and 1 done."),
  ],
};
