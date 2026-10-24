// node --test mockkit/test  (no T3 needed). Drives the Claude stream-json mock over stdio exactly like the Claude Agent SDK does
// (control_request initialize / user messages / control_response to can_use_tool).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { editInput, parseArgs, structuredPatch, toolFor } from "../adapters/claude.mjs";
import { enqueue } from "../lib/queue.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/t3-mock-claude.mjs");
const launcher = join(here, "../bin/mock-cli.sh");
const STREAM_ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--include-partial-messages"];
const procs = new Set();
after(() => procs.forEach((p) => p.kill("SIGKILL")));
const UUID = "11111111-1111-4111-8111-111111111111";

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "mk-cl-ws-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/greeting.ts"), "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(cwd, "README.md"), "# hi\n");
  writeFileSync(join(cwd, "package.json"), "{}\n");
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

// args = extra CLI flags after the stream-json base set (e.g. ["--permission-mode", "bypassPermissions"])
function client({ cwd = workspace(), env = {}, args = [], base = STREAM_ARGS } = {}) {
  const p = spawn(process.execPath, [bin, ...base, ...args], {
    cwd,
    env: { ...process.env, MOCK_PACE: "fast", MOCK_CONTROL_DIR: join(cwd, ".ctl"), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  procs.add(p);
  const frames = [];
  const waiters = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      frames.push(JSON.parse(line));
      waiters.slice().forEach((w) => w());
    }
  });
  let rid = 0;
  const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = (pred) =>
    new Promise((resolve) => {
      const check = () => {
        const f = frames.find(pred);
        if (f) {
          waiters.splice(waiters.indexOf(check), 1);
          resolve(f);
        }
      };
      waiters.push(check);
      check();
    });
  const control = (request) => {
    const request_id = `req_${++rid}`;
    send({ type: "control_request", request_id, request });
    return waitFor((f) => f.type === "control_response" && f.response.request_id === request_id).then((f) => f.response);
  };
  const user = (text, uuid = UUID) => send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid });
  const result = (n = 1) => waitFor(() => frames.filter((f) => f.type === "result").length >= n).then(() => frames.filter((f) => f.type === "result")[n - 1]);
  const permissionRequest = (tool) => waitFor((f) => f.type === "control_request" && f.request.subtype === "can_use_tool" && (!tool || f.request.tool_name === tool));
  const answer = (req, response) => send({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } });
  return { p, frames, send, control, user, result, waitFor, permissionRequest, answer, cwd, close: () => p.stdin.end() };
}

const assistantText = (frames) => frames.filter((f) => f.type === "assistant").flatMap((f) => f.message.content.filter((b) => b.type === "text").map((b) => b.text)).join("");
const blocks = (frames, type) => frames.filter((f) => f.type === "assistant").flatMap((f) => f.message.content.filter((b) => b.type === type));
const toolResults = (frames) => frames.filter((f) => f.type === "user").flatMap((f) => f.message.content.filter((b) => b.type === "tool_result"));

test("launcher: --version, auth status, flavor routing by env and by argv (no grok leakage)", () => {
  const v = spawnSync("sh", [launcher, "--version"], { env: { ...process.env, MOCK_CLI_FLAVOR: "claude" }, encoding: "utf8" });
  assert.equal(v.stdout.trim(), "2.1.300 (Claude Code)");
  const bare = spawnSync("sh", [launcher, "auth", "status"], { encoding: "utf8" });
  assert.equal(JSON.parse(bare.stdout).loggedIn, true);
  assert.equal(JSON.parse(bare.stdout).authMethod, "claude.ai");
  const old = spawnSync("sh", [launcher, "--version"], { env: { ...process.env, MOCK_CLI_FLAVOR: "claude", MOCK_CLI_MODE: "old" }, encoding: "utf8" });
  assert.equal(old.stdout.trim(), "2.0.1 (Claude Code)");
  const unauth = spawnSync("sh", [launcher, "auth", "status"], { env: { ...process.env, MOCK_CLI_MODE: "unauth" }, encoding: "utf8" });
  assert.equal(unauth.status, 1);
  assert.equal(JSON.parse(unauth.stdout).loggedIn, false);
  // grok stays grok without the flavor
  assert.match(spawnSync("sh", [launcher, "--version"], { encoding: "utf8", env: { ...process.env, MOCK_CLI_FLAVOR: "" } }).stdout, /^grok /);
});

test("parseArgs understands `--k=v`, `--k v` and bare flags", () => {
  const { flags } = parseArgs(["--output-format", "stream-json", "--resume=abc", "--session-id=sid", "--model", "claude-opus-5-5", "--permission-mode", "plan", "--allow-dangerously-skip-permissions", "-p", "--tools", ""]);
  assert.equal(flags["--output-format"], "stream-json");
  assert.equal(flags["--resume"], "abc");
  assert.equal(flags["--session-id"], "sid");
  assert.equal(flags["--model"], "claude-opus-5-5");
  assert.equal(flags["--permission-mode"], "plan");
  assert.equal(flags["--allow-dangerously-skip-permissions"], true);
  assert.equal(flags["--print"], true);
  assert.equal(flags["--tools"], "");
});

test("initialize control request: account (claude.ai max, no api key), commands, models; get_usage; unknown subtype errors", async () => {
  const c = client({ env: { ANTHROPIC_API_KEY: "sk-ant-should-never-be-used" } });
  const init = await c.control({ subtype: "initialize", hooks: undefined });
  assert.equal(init.subtype, "success");
  const r = init.response;
  assert.equal(r.account.tokenSource, "claude.ai");
  assert.equal(r.account.subscriptionType, "max");
  assert.equal(r.account.apiProvider, "firstParty");
  assert.equal(r.account.apiKeySource, "none");
  assert.ok(r.commands.length > 0 && r.commands.every((x) => x.name && typeof x.description === "string" && "argumentHint" in x));
  assert.ok(r.models.some((m) => m.value === "claude-opus-5-5"));
  const usage = (await c.control({ subtype: "get_usage" })).response;
  assert.equal(usage.rate_limits_available, true);
  assert.equal(usage.subscription_type, "max");
  assert.ok(usage.rate_limits.five_hour.utilization >= 0 && usage.rate_limits.seven_day.resets_at);
  assert.deepEqual((await c.control({ subtype: "mcp_set_servers", servers: { "t3-code": { type: "http", url: "http://127.0.0.1:1/mcp" } } })).response, { added: ["t3-code"], removed: [], errors: {} });
  const bad = await c.control({ subtype: "made_up" });
  assert.equal(bad.subtype, "error");
  assert.equal((await c.control({ subtype: "set_model", model: "claude-opus-5-5" })).subtype, "success");
  assert.equal((await c.control({ subtype: "set_permission_mode", mode: "plan" })).subtype, "success");
  assert.ok(!JSON.stringify(c.frames).includes("sk-ant-should-never-be-used"));
  c.close();
});

test("unauth mode: initialize reports no token source (T3: Claude Code is not authenticated)", async () => {
  const c = client({ env: { MOCK_CLI_MODE: "unauth" } });
  const r = (await c.control({ subtype: "initialize" })).response;
  assert.equal(r.account.tokenSource, "none");
  assert.equal(r.account.email, undefined);
  c.close();
});

test("echo turn: init -> stream_event deltas -> assistant snapshot -> result (usage, uuid echo), turn 2 sees history", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("Hello there", UUID);
  const r1 = await c.result(1);
  const f1 = c.frames.slice();
  assert.equal(f1.find((f) => f.type === "system").subtype, "init");
  const init = f1.find((f) => f.type === "system");
  assert.equal(init.apiKeySource, "none");
  assert.equal(init.permissionMode, "default");
  assert.ok(init.claude_code_version);
  const ev = f1.filter((f) => f.type === "stream_event").map((f) => f.event.type);
  assert.deepEqual(ev, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.match(assistantText(f1), /Mock agent, turn 1\. You said: "Hello there"\. This is the first turn\./);
  assert.equal(r1.subtype, "success");
  assert.equal(r1.is_error, false);
  assert.equal(r1.user_message_uuid, UUID);
  assert.deepEqual(r1.user_message_uuids, [UUID]);
  assert.equal(r1.terminal_reason, "completed");
  assert.ok(r1.usage.input_tokens > 0 && r1.usage.output_tokens > 0);
  assert.ok(r1.modelUsage["claude-sonnet-5-5"].contextWindow > 0);
  assert.equal(r1.session_id, init.session_id);
  c.user("Second message", "22222222-2222-4222-8222-222222222222");
  const r2 = await c.result(2);
  assert.match(r2.result, /turn 2\. You said: "Second message"\. Your previous message was: "Hello there"/);
  c.close();
});

test("every assistant frame has its own uuid (T3 keys text by uuid); frames never mention grok/codex or the api key", async () => {
  const c = client({ env: { ANTHROPIC_API_KEY: "sk-ant-leak-check" } });
  await c.control({ subtype: "initialize" });
  c.user("[mock:think] go");
  await c.result(1);
  const a = c.frames.filter((f) => f.type === "assistant");
  assert.ok(a.length >= 2);
  assert.equal(new Set(a.map((f) => f.uuid)).size, a.length);
  const all = JSON.stringify(c.frames).toLowerCase();
  assert.ok(!all.includes("grok") && !all.includes("codex") && !all.includes("sk-ant-leak-check"), "no provider leakage");
  c.close();
});

test("think scenario: thinking block (stream thinking_delta + snapshot) then text", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:think] go");
  await c.result(1);
  const deltas = c.frames.filter((f) => f.type === "stream_event" && f.event.delta?.type === "thinking_delta");
  assert.ok(deltas.length > 0);
  const th = blocks(c.frames, "thinking");
  assert.equal(th.length, 1);
  assert.match(th[0].thinking, /simpler one/);
  assert.match(assistantText(c.frames), /simpler approach wins/);
  c.close();
});

test("tool-read: Read + Grep tool_use rows with numbered tool_result content", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:tool-read] go");
  await c.result(1);
  const uses = blocks(c.frames, "tool_use");
  assert.deepEqual(uses.map((u) => u.name), ["Read", "Read", "Grep"]);
  assert.ok(uses[0].input.file_path.endsWith("README.md"));
  const res = toolResults(c.frames);
  assert.equal(res.length, 3);
  assert.match(res[0].content, /^\s+1→# hi/);
  assert.equal(res.every((r) => r.is_error === false), true);
  assert.equal(res[0].tool_use_id, uses[0].id);
  const structured = c.frames.find((f) => f.type === "user" && f.tool_use_result?.file);
  assert.equal(structured.tool_use_result.file.totalLines, 2);
  c.close();
});

test("edit-file-diff under bypassPermissions: real fs writes, Edit (old/new string) + Write, structuredPatch, never asks", async () => {
  const c = client({ args: ["--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"] });
  await c.control({ subtype: "initialize" });
  c.user("[mock:edit-file-diff] go");
  await c.result(1);
  assert.equal(c.frames.filter((f) => f.type === "control_request").length, 0);
  const uses = blocks(c.frames, "tool_use");
  const edit = uses.find((u) => u.name === "Edit");
  assert.ok(edit, "an Edit tool_use");
  assert.match(edit.input.old_string, /Hello, \$\{name\}!/);
  assert.ok(edit.input.new_string.length > 0 && edit.input.new_string !== edit.input.old_string);
  assert.ok(uses.some((u) => u.name === "Write"));
  const greeting = readFileSync(join(c.cwd, "src/greeting.ts"), "utf8");
  assert.notEqual(greeting, "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  const patch = c.frames.find((f) => f.type === "user" && f.tool_use_result?.structuredPatch?.length)?.tool_use_result;
  assert.ok(patch.structuredPatch[0].lines.some((l) => l.startsWith("-")) && patch.structuredPatch[0].lines.some((l) => l.startsWith("+")));
  assert.equal(patch.userModified, false);
  c.close();
});

test("approval-allow (default mode): can_use_tool Write, file only appears after allow; title + suggestions present", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:approval-allow] go");
  const req = await c.permissionRequest("Write");
  assert.equal(req.request.tool_use_id, blocks(c.frames, "tool_use").find((u) => u.name === "Write").id);
  assert.match(req.request.title, /^Claude wants to create .*NOTES\.md$/);
  assert.equal(req.request.permission_suggestions[0].type, "setMode");
  assert.equal(req.request.input.content.startsWith("# Notes"), true);
  assert.equal(existsSync(join(c.cwd, "NOTES.md")), false, "nothing written before the decision");
  c.answer(req, { behavior: "allow", updatedInput: req.request.input });
  const r = await c.result(1);
  assert.equal(existsSync(join(c.cwd, "NOTES.md")), true);
  assert.match(r.result, /Approved: `NOTES\.md` was written\./);
  assert.equal(toolResults(c.frames)[0].content.startsWith("File created successfully"), true);
  c.close();
});

test("approval-deny: Bash can_use_tool, deny message becomes the tool_result error, onReject text follows, nothing ran", async () => {
  const c = client();
  mkdirSync(join(c.cwd, "dist"));
  writeFileSync(join(c.cwd, "dist/keep.txt"), "x");
  await c.control({ subtype: "initialize" });
  c.user("[mock:approval-deny] go");
  const req = await c.permissionRequest("Bash");
  assert.match(req.request.title, /^Claude wants to run: rm -rf dist/);
  assert.equal(req.request.permission_suggestions[0].type, "addRules");
  c.answer(req, { behavior: "deny", message: "Declined by the user" });
  const r = await c.result(1);
  assert.equal(existsSync(join(c.cwd, "dist/keep.txt")), true);
  const tr = toolResults(c.frames)[0];
  assert.equal(tr.is_error, true);
  assert.equal(tr.content, "Declined by the user");
  assert.match(r.result, /Understood, I will leave `dist` untouched/);
  c.close();
});

test("acceptEdits auto-allows file edits but still asks for Bash; 'allow always' (addRules) skips later prompts", async () => {
  const c = client({ args: ["--permission-mode", "acceptEdits"] });
  await c.control({ subtype: "initialize" });
  c.user("[mock:approval-allow] go");
  await c.result(1);
  assert.equal(c.frames.filter((f) => f.type === "control_request").length, 0, "Write is auto-allowed, S.sh inside onAllow is not a permission step");
  assert.equal(existsSync(join(c.cwd, "NOTES.md")), true);
  c.user("[mock:approval-deny] go", "33333333-3333-4333-8333-333333333333");
  const req = await c.permissionRequest("Bash");
  c.answer(req, { behavior: "allow", updatedInput: req.request.input, updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }] });
  await c.result(2);
  c.user("[mock:approval-deny] again", "44444444-4444-4444-8444-444444444444");
  await c.result(3);
  assert.equal(c.frames.filter((f) => f.type === "control_request").length, 1, "second Bash did not ask again");
  c.close();
});

test("set_permission_mode bypassPermissions at runtime stops prompts; accepting setMode acceptEdits applies it", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  await c.control({ subtype: "set_permission_mode", mode: "bypassPermissions" });
  c.user("[mock:approval-allow] go");
  await c.result(1);
  assert.equal(c.frames.filter((f) => f.type === "control_request").length, 0);
  c.close();
  const d = client();
  await d.control({ subtype: "initialize" });
  d.user("[mock:approval-allow] go");
  const req = await d.permissionRequest("Write");
  d.answer(req, { behavior: "allow", updatedInput: req.request.input, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
  await d.result(1);
  d.user("[mock:approval-allow] again", "55555555-5555-4555-8555-555555555555");
  await d.result(2);
  assert.equal(d.frames.filter((f) => f.type === "control_request").length, 1);
  assert.equal(d.frames.filter((f) => f.type === "system" && f.subtype === "init").at(-1).permissionMode, "acceptEdits");
  d.close();
});

test("ask: AskUserQuestion control request (always, even under bypass); answers keyed by question text feed the scenario", async () => {
  const c = client({ args: ["--permission-mode", "bypassPermissions"] });
  await c.control({ subtype: "initialize" });
  c.user("[mock:ask] go");
  const req = await c.permissionRequest("AskUserQuestion");
  const q = req.request.input.questions[0];
  assert.equal(q.question, "Which code style should the mock follow?");
  assert.ok(q.header.length <= 12);
  assert.equal(q.multiSelect, false);
  assert.deepEqual(q.options.map((o) => o.label), ["Strict (Recommended)", "Flexible"]);
  c.answer(req, { behavior: "allow", updatedInput: { questions: req.request.input.questions, answers: { [q.question]: "Flexible" } } });
  const r = await c.result(1);
  assert.match(r.result, /Thanks, going with: \["Flexible"\]/);
  assert.match(toolResults(c.frames)[0].content, /User has answered your questions: "Which code style should the mock follow\?"="Flexible"/);
  c.close();
});

test("exit-plan: ExitPlanMode tool_use {plan} + can_use_tool (even under bypass); T3-style deny ends as error tool_result, turn continues", async () => {
  const c = client({ args: ["--permission-mode", "bypassPermissions"] });
  await c.control({ subtype: "initialize" });
  c.user("[mock:exit-plan] go");
  const req = await c.permissionRequest("ExitPlanMode");
  assert.match(req.request.input.plan, /^# Refactor the greeting helper/);
  const use = blocks(c.frames, "tool_use").find((u) => u.name === "ExitPlanMode");
  assert.equal(use.id, req.request.tool_use_id);
  c.answer(req, { behavior: "deny", message: "The client captured your proposed plan." });
  const r = await c.result(1);
  assert.equal(toolResults(c.frames)[0].is_error, true);
  assert.equal(toolResults(c.frames)[0].content, "The client captured your proposed plan.");
  assert.match(r.result, /The plan is ready for your review\./);
  c.close();
});

test("plan scenario -> TodoWrite tool_use rows (content/status/activeForm) + tool_result", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:plan] go");
  await c.result(1);
  const todos = blocks(c.frames, "tool_use").filter((u) => u.name === "TodoWrite");
  assert.ok(todos.length >= 2);
  assert.deepEqual(todos[0].input.todos.map((t) => t.status), ["in_progress", "pending", "pending"]);
  assert.ok(todos[0].input.todos.every((t) => t.content && t.activeForm));
  c.close();
});

test("shell: Bash tool_use + stdout in tool_result, exit code failures are is_error", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  enqueue("shell", {}, { cwd: c.cwd, env: { MOCK_CONTROL_DIR: join(c.cwd, ".ctl") } });
  c.user("run the build please");
  await c.result(1);
  const bash = blocks(c.frames, "tool_use").find((u) => u.name === "Bash");
  assert.equal(bash.input.description, "npm run build");
  const tr = toolResults(c.frames)[0];
  assert.match(tr.content, /build finished/);
  assert.equal(tr.is_error, false);
  const st = c.frames.find((f) => f.type === "user" && f.tool_use_result?.stdout !== undefined).tool_use_result;
  assert.equal(st.interrupted, false);
  c.close();
}, { timeout: 30_000 });

test("hidden routing: queue (mockctl next) picks the scenario per cwd without any [mock:] tag in the prompt", async () => {
  const cwd = workspace();
  enqueue("error-turn", {}, { cwd, env: { MOCK_CONTROL_DIR: join(cwd, ".ctl") } });
  const c = client({ cwd });
  await c.control({ subtype: "initialize" });
  c.user("Please do the thing");
  const r = await c.result(1);
  assert.equal(r.is_error, true);
  c.close();
});

test("error-turn: synthetic assistant 'API Error: ...' + is_error result (api_error)", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:error-turn] go");
  const r = await c.result(1);
  assert.equal(r.subtype, "success");
  assert.equal(r.is_error, true);
  assert.equal(r.terminal_reason, "api_error");
  assert.match(r.result, /^API Error: API error \(status 400 Bad Request\)/);
  const syn = c.frames.filter((f) => f.type === "assistant").at(-1);
  assert.equal(syn.message.model, "<synthetic>");
  c.close();
});

test("usage-limit: rate_limit_event (rejected, resetsAt) + assistant error rate_limit with api_error_params + blocking_limit result", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:usage-limit] go");
  const r = await c.result(1);
  const ev = c.frames.find((f) => f.type === "rate_limit_event");
  assert.equal(ev.rate_limit_info.status, "rejected");
  assert.equal(ev.rate_limit_info.rateLimitType, "five_hour");
  assert.ok(ev.rate_limit_info.resetsAt > Date.now() / 1000);
  const syn = c.frames.filter((f) => f.type === "assistant").at(-1);
  assert.equal(syn.error, "rate_limit");
  assert.equal(syn.api_error_params.rate_limit_info.status, "rejected");
  assert.equal(r.is_error, true);
  assert.equal(r.terminal_reason, "blocking_limit");
  assert.match(r.result, /hit your limit/);
  assert.ok(c.frames.indexOf(ev) < c.frames.indexOf(syn) && c.frames.indexOf(syn) < c.frames.indexOf(r), "limit event, then assistant error, then result");
  c.close();
});

test("interrupt: control_request interrupt aborts a held turn -> error_during_execution result; next turn works", async () => {
  const c = client({ env: { MOCK_HOLD_TIMEOUT_MS: "20000" } });
  await c.control({ subtype: "initialize" });
  c.user("[mock:slow hold=gate] go");
  await c.waitFor((f) => f.type === "assistant" && f.message.content.some((b) => b.type === "text"));
  assert.equal((await c.control({ subtype: "interrupt" })).subtype, "success");
  const r = await c.result(1);
  assert.equal(r.subtype, "error_during_execution");
  assert.equal(r.is_error, true);
  assert.equal(r.terminal_reason, "aborted_streaming");
  assert.deepEqual(r.errors.length > 0, true);
  c.user("[mock:echo] again", "66666666-6666-4666-8666-666666666666");
  assert.match((await c.result(2)).result, /Mock agent, turn 2/);
  c.close();
});

test("held turn: hold gate released from outside resumes the scenario", async () => {
  const c = client({ env: { MOCK_HOLD_TIMEOUT_MS: "20000" } });
  await c.control({ subtype: "initialize" });
  c.user("[mock:slow hold=g2] go");
  await c.waitFor(() => existsSync(join(c.cwd, ".ctl/reached/g2")));
  mkdirSync(join(c.cwd, ".ctl/release"), { recursive: true });
  writeFileSync(join(c.cwd, ".ctl/release/g2"), "1");
  assert.match((await c.result(1)).result, /Finished the long task\./);
  c.close();
});

test("live-stream (real pace, held mid-turn): steps 1-5 are ONE text block (one message), closed by the idle timer while held", async () => {
  const c = client({ env: { MOCK_PACE: "real", MOCK_HOLD_TIMEOUT_MS: "20000" } });
  await c.control({ subtype: "initialize" });
  c.user("[mock:live-stream hold=h5] go");
  await c.waitFor(() => existsSync(join(c.cwd, ".ctl/reached/h5")));
  await c.waitFor((f) => f.type === "assistant" && f.message.content.some((b) => b.type === "text" && /Step 5 of 8/.test(b.text)));
  const held = blocks(c.frames, "text");
  assert.equal(held.length, 1, `expected one block, got ${held.map((b) => JSON.stringify(b.text)).join(" | ")}`);
  assert.match(held[0].text, /Step 1 of 8[\s\S]*Step 5 of 8/);
  assert.doesNotMatch(held[0].text, /Step 6 of 8/);
  mkdirSync(join(c.cwd, ".ctl/release"), { recursive: true });
  writeFileSync(join(c.cwd, ".ctl/release/h5"), "1");
  assert.match((await c.result(1)).result, /Live stream complete/);
  c.close();
});

test("resume: --session-id is reported in init; --resume=<id> after a respawn keeps the turn counter + history", async () => {
  const cwd = workspace();
  const ctl = { MOCK_CONTROL_DIR: join(cwd, ".ctl") };
  const a = client({ cwd, env: ctl, args: ["--session-id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "--model", "claude-opus-5-5"] });
  await a.control({ subtype: "initialize" });
  a.user("first message");
  const r1 = await a.result(1);
  assert.equal(r1.session_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(a.frames.find((f) => f.type === "system").model, "claude-opus-5-5");
  a.close();
  await new Promise((r) => a.p.on("exit", r));
  const b = client({ cwd, env: ctl, args: ["--resume=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] });
  await b.control({ subtype: "initialize" });
  b.user("second message");
  const r2 = await b.result(1);
  assert.match(r2.result, /turn 2\. You said: "second message"\. Your previous message was: "first message"/);
  assert.equal(r2.session_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(b.frames.find((f) => f.type === "system").model, "claude-opus-5-5");
  b.close();
});

test("context usage: queue arg tokens=<n> forces the input size reported in message_start + result", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.user("[mock:echo tokens=190000] big");
  const r = await c.result(1);
  assert.equal(r.usage.input_tokens, 190000);
  const ms = c.frames.find((f) => f.type === "stream_event" && f.event.type === "message_start");
  assert.equal(ms.event.message.usage.input_tokens, 190000);
  c.close();
});

test("text generation: claude -p --output-format json --json-schema -> structured_output envelope (title from scenario)", () => {
  const schema = JSON.stringify({ type: "object", properties: { title: { type: "string" } }, required: ["title"] });
  const r = spawnSync(process.execPath, [bin, "-p", "--output-format", "json", "--json-schema", schema, "--model", "claude-haiku-5-5", "--tools", "", "--permission-mode", "dontAsk"], {
    input: "Return a JSON object with key title.\n\nUser message:\n[mock:error-turn] please fail",
    encoding: "utf8",
    env: { ...process.env, MOCK_CONTROL_DIR: mkdtempSync(join(tmpdir(), "mk-cl-ctl-")) },
  });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout);
  assert.equal(env.type, "result");
  assert.equal(env.is_error, false);
  assert.deepEqual(env.structured_output, { title: "Failing turn" });
});

test("text generation: commit message keys (subject/body) and unknown required keys are filled", () => {
  const schema = JSON.stringify({ type: "object", properties: { subject: { type: "string" }, body: { type: "string" }, extra: { type: "string" } } });
  const r = spawnSync(process.execPath, [bin, "-p", "--output-format", "json", "--json-schema", schema], { input: "Return a commit message as JSON with subject and body.\n\nUser message:\nx", encoding: "utf8", env: { ...process.env, MOCK_CONTROL_DIR: mkdtempSync(join(tmpdir(), "mk-cl-ctl-")) } });
  const out = JSON.parse(r.stdout).structured_output;
  assert.equal(out.subject, "Update files via mock agent");
  assert.ok(out.body && out.extra === "mock");
});

test("pure helpers: toolFor, editInput, structuredPatch", () => {
  assert.deepEqual(toolFor({ kind: "read", input: { path: "/w/a.ts" } }), { name: "Read", input: { file_path: "/w/a.ts" } });
  assert.deepEqual(toolFor({ kind: "execute", title: "npm test", input: { command: "npm test" } }), { name: "Bash", input: { command: "npm test" } });
  assert.deepEqual(toolFor({ kind: "execute", title: "Run tests", input: { command: "npm test" } }).input, { command: "npm test", description: "Run tests" });
  assert.equal(toolFor({ kind: "edit", diff: { path: "/w/n.ts", oldText: "", newText: "x\n" } }).name, "Write");
  assert.equal(toolFor({ kind: "edit", diff: { path: "/w/n.ts", oldText: "a\n", newText: "b\n" } }).name, "Edit");
  assert.equal(toolFor({ kind: "other", title: "Fetch docs" }).name, "mcp__mockkit__fetch_docs");
  const e = editInput("/w/f.ts", "l1\nl2\nl3\nl4\n", "l1\nl2\nCHANGED\nl4\n");
  assert.equal(e.old_string, "l2\nl3\nl4");
  assert.equal(e.new_string, "l2\nCHANGED\nl4");
  const hunk = structuredPatch("l1\nl2\nl3\n", "l1\nX\nl3\n")[0];
  assert.deepEqual(hunk.lines, [" l1", "-l2", "+X", " l3"]);
  assert.equal(hunk.oldStart, 1);
});

test("stdin close ends the process cleanly; unsupported argv exits 2", async () => {
  const c = client();
  await c.control({ subtype: "initialize" });
  c.close();
  const code = await new Promise((r) => c.p.on("exit", r));
  assert.equal(code, 0);
  const bad = spawnSync(process.execPath, [bin, "--made-up"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unsupported args/);
});
