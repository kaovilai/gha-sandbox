#!/usr/bin/env node
// Entry: zero-dep mock `codex` CLI. Handles (first match in argv, config flags may precede it):
//   app-server [args]          newline-delimited JSON-RPC (what T3's codex driver spawns)
//   exec [args] -              text generation: prompt on stdin, JSON to --output-last-message FILE
//   mcp list --json            "[]" (T3 lists MCP servers before text generation)
//   --version | -V             codex-cli 0.159.0
//   login status               signed-in line
// Env: MOCK_LOG, MOCK_PACE, MOCK_SEED, MOCK_DEFAULT_SCENARIO, MOCK_CONTROL_DIR, MOCK_HOLD_TIMEOUT_MS,
//      MOCK_CLI_MODE (ready|unauth|old), MOCK_CODEX_ACCOUNT (apiKey default | chatgpt).
import { CODEX_VERSION, execText, serveCodex } from "../adapters/codex.mjs";

process.on("SIGTERM", () => process.exit(0));
const argv = process.argv.slice(2);
const idx = argv.findIndex((a) => ["app-server", "exec", "mcp", "login", "--version", "-V"].includes(a));
const cmd = idx >= 0 ? argv[idx] : "";
const rest = idx >= 0 ? argv.slice(idx + 1) : [];

if (cmd === "app-server") {
  await serveCodex();
} else if (cmd === "exec") {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdin += chunk;
  await execText({ argv: rest, stdin });
} else if (cmd === "mcp") {
  process.stdout.write("[]\n");
} else if (cmd === "login") {
  process.stdout.write("Logged in using an API key (mock)\n");
} else if (cmd === "--version" || cmd === "-V") {
  process.stdout.write(`codex-cli ${CODEX_VERSION}\n`);
} else {
  process.stderr.write(`mock codex: unsupported args: ${argv.join(" ")}\n`);
  process.exit(2);
}
process.exit(0);
