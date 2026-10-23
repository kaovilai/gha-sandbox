import { S } from "../lib/ir.mjs";

const MD = `## Streaming markdown demo

This reply is produced by the **mock agent**, streamed in small chunks so the timeline *grows* while it renders. Inline \`code\`, a [link](https://example.com) and ~~strikethrough~~ are all supported.

### Why a mock?

- Deterministic output, no API key
- Real pacing (word chunks with seeded jitter)
- Works the same in CI and locally

1. Send a prompt
2. Watch it stream
3. Capture a screenshot

| Provider | Kind | Needs key |
| -------- | ---- | --------- |
| grok (mock) | ACP | no |
| codex | JSON-RPC | yes |
| claude | SDK | yes |

> Blockquote: the mock never calls a model.

\`\`\`ts
export function greet(name: string): string {
  const who = name.trim() || "world";
  return \`Hello, \${who}!\`;
}
\`\`\`

\`\`\`sh
git status --short && echo "done"
\`\`\`

That is the end of the **markdown** stream.`;

// Claude flavor (MOCK_CLI_FLAVOR=claude, set on the claude instance): the provider table names Claude models only, so no
// other vendor shows up in Claude recordings.
const CLAUDE_TABLE = `| Provider | Kind | Needs key |
| -------- | ---- | --------- |
| claude (mock) | stream-json | no |
| claude-sonnet | API | yes |
| claude-opus | API | yes |`;
const mdFor = (flavor) => (flavor === "claude" ? MD.replace(/\| Provider[\s\S]*?\| claude \| SDK \| yes \|/, CLAUDE_TABLE) : MD);

export default {
  id: "markdown-stream",
  title: "Markdown streaming demo",
  steps: (ctx) => [S.say(mdFor(ctx.env?.MOCK_CLI_FLAVOR), { chunk: 3, paceMs: 70 })],
};
