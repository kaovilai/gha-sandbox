#!/usr/bin/env node
// Entry: zero-dep mock `claude` CLI (what T3's claudeAgent driver / Claude Agent SDK spawns). Chosen by:
//   --input-format stream-json | --output-format stream-json (no -p)   stream-json session (SDK)
//   -p | --print                                                      text generation: prompt on stdin, JSON envelope on stdout
//   auth status                                                       logged-in JSON
//   --version | -v                                                    "2.1.300 (Claude Code)"
// Env: MOCK_LOG, MOCK_PACE, MOCK_SEED, MOCK_DEFAULT_SCENARIO, MOCK_CONTROL_DIR, MOCK_HOLD_TIMEOUT_MS, MOCK_CLI_MODE (ready|unauth|old).
import { CLAUDE_VERSION, authStatus, parseArgs, printText, serveClaude } from "../adapters/claude.mjs";

process.on("SIGTERM", () => process.exit(0));
const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);

if (argv.includes("--version") || argv.includes("-v") || argv.includes("-V")) {
  process.stdout.write(`${process.env.MOCK_CLI_MODE === "old" ? "2.0.1" : CLAUDE_VERSION} (Claude Code)\n`);
} else if (positional[0] === "auth" && positional[1] === "status") {
  process.exitCode = authStatus();
} else if (flags["--print"]) {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdin += chunk;
  await printText({ argv, stdin });
} else if (flags["--input-format"] === "stream-json" || flags["--output-format"] === "stream-json") {
  await serveClaude({ argv });
} else {
  process.stderr.write(`mock claude: unsupported args: ${argv.join(" ")}\n`);
  process.exitCode = 2;
}
process.exit(process.exitCode ?? 0);
