// Manual protocol check: drive the REAL Claude Agent SDK against the mock launcher (what T3's claudeAgent driver does).
// Not part of `node --test` (needs the SDK: `npm i @anthropic-ai/claude-agent-sdk --omit=optional` in a scratch dir, then run from there).
//   node claude-sdk-drive.mjs <repo root> <scenario id> [permissionMode] [allow|deny]
//   e.g. ... . approval-allow default allow | ask | exit-plan | edit-file-diff bypassPermissions | usage-limit
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const WT = process.argv[2];
const scenario = process.argv[3] || "echo";
const permissionMode = process.argv[4] || "default";
const answerMode = process.argv[5] || "allow";
const ctl = mkdtempSync(join(tmpdir(), "ctl-"));
const ws = mkdtempSync(join(tmpdir(), "ws-"));
mkdirSync(join(ws, "src"));
writeFileSync(join(ws, "src/greeting.ts"), "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
writeFileSync(join(ws, "README.md"), "# demo\n");
writeFileSync(join(ws, "package.json"), "{}\n");
const env = { ...process.env, MOCK_CLI_FLAVOR: "claude", MOCK_PACE: "fast", MOCK_CONTROL_DIR: ctl, MOCK_LOG: join(ctl, "log.ndjson"), MOCK_NODE: process.execPath };
delete env.ANTHROPIC_API_KEY;
async function* prompts() {
  yield { type: "user", message: { role: "user", content: `[mock:${scenario}] hi` }, parent_tool_use_id: null, uuid: "11111111-1111-4111-8111-111111111111" };
  await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 4000)));
}
const q = query({
  prompt: prompts(),
  options: {
    pathToClaudeCodeExecutable: join(WT, "mockkit/bin/mock-cli.sh"),
    cwd: ws,
    env,
    permissionMode,
    includePartialMessages: true,
    sessionId: "22222222-2222-4222-8222-222222222222",
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    canUseTool: async (name, input, o) => {
      console.log("CAN_USE_TOOL", name, JSON.stringify(input).slice(0, 120), "|", o.title);
      if (name === "AskUserQuestion") {
        const q0 = input.questions[0];
        return { behavior: "allow", updatedInput: { questions: input.questions, answers: { [q0.question]: q0.options[0].label } } };
      }
      if (name === "ExitPlanMode") return { behavior: "deny", message: "captured plan" };
      return answerMode === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "no thanks" };
    },
  },
});
const init = await q.initializationResult();
console.log("INIT account", JSON.stringify(init.account), "cmds", init.commands.length, "models", init.models.length);
console.log("USAGE", JSON.stringify((await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })).rate_limits));
for await (const m of q) {
  const b = m.message?.content?.[0];
  const txt = b?.text ?? b?.thinking ?? (typeof b?.content === "string" ? b.content : "") ?? "";
  console.log(m.type, m.subtype ?? "", m.event?.type ?? "", m.event?.delta?.type ?? "", b?.type ?? "", b?.name ?? "", String(txt).slice(0, 90).replace(/\n/g, "\\n"), m.type === "result" ? `is_error=${m.is_error} ${String(m.result).slice(0, 60)}` : "");
  if (m.type === "result") {
    q.close();
    break;
  }
}
