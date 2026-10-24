// node --test mockkit/test  (no T3 needed). Claude-gaps track: subagents (Agent tool + child frames), background Bash/Monitor + TaskOutput/TaskStop + wake turn,
// hooks, MCP tool rows, WebSearch/WebFetch, /compact, skills, rewind (--resume-session-at), image blocks, api_retry, notices.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toolFor } from "../adapters/claude.mjs";
import { S, runSteps } from "../lib/ir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/t3-mock-claude.mjs");
const STREAM_ARGS = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--include-partial-messages"];
const procs = new Set();
after(() => procs.forEach((p) => p.kill("SIGKILL")));
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "mk-clg-ws-"));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "assets"));
  writeFileSync(join(cwd, "src/greeting.ts"), "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(cwd, "package.json"), '{"scripts":{"build":"tsc"}}\n');
  writeFileSync(join(cwd, "README.md"), "# hi\n");
  writeFileSync(join(cwd, "assets/logo.png"), Buffer.from(PNG_1X1, "base64"));
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

function client({ cwd = workspace(), env = {}, args = [] } = {}) {
  const p = spawn(process.execPath, [bin, ...STREAM_ARGS, ...args], { cwd, env: { ...process.env, MOCK_PACE: "fast", MOCK_CONTROL_DIR: join(cwd, ".ctl"), ...env }, stdio: ["pipe", "pipe", "inherit"] });
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
  const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = (pred, ms = 15000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for frame; got ${frames.map((f) => `${f.type}:${f.subtype ?? ""}`).join(" ")}`)), ms);
      const check = () => {
        const f = frames.find(pred);
        if (f) {
          clearTimeout(t);
          waiters.splice(waiters.indexOf(check), 1);
          resolve(f);
        }
      };
      waiters.push(check);
      check();
    });
  const user = (content) => send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  const result = (n = 1) => waitFor(() => frames.filter((f) => f.type === "result").length >= n).then(() => frames.filter((f) => f.type === "result")[n - 1]);
  return { p, frames, send, user, result, waitFor, cwd, close: () => p.stdin.end() };
}

const toolUses = (frames) => frames.filter((f) => f.type === "assistant").flatMap((f) => f.message.content.filter((b) => b.type === "tool_use").map((b) => ({ ...b, parent: f.parent_tool_use_id, meta: f.tool_use_meta })));
const toolResults = (frames) => frames.filter((f) => f.type === "user").flatMap((f) => (Array.isArray(f.message.content) ? f.message.content.filter((b) => b.type === "tool_result").map((b) => ({ ...b, parent: f.parent_tool_use_id, structured: f.tool_use_result })) : []));
const sys = (frames, subtype) => frames.filter((f) => f.type === "system" && f.subtype === subtype);
const texts = (frames, parent = null) => frames.filter((f) => f.type === "assistant" && f.parent_tool_use_id === parent).flatMap((f) => f.message.content.filter((b) => b.type === "text").map((b) => b.text));

test("subagent: Agent tool_use, task_started, child frames tagged with the Agent tool_use id, task_progress, task_notification, Agent tool_result", async () => {
  const c = client();
  c.user("[mock:subagent-spawn]");
  await c.result();
  const uses = toolUses(c.frames);
  const agents = uses.filter((u) => u.name === "Agent");
  assert.equal(agents.length, 2);
  assert.deepEqual(agents[0].input, { description: "explorer", subagent_type: "general-purpose", prompt: "Find where greet() is defined and used under src/.", run_in_background: false });
  assert.equal(agents[0].parent, null);
  const started = sys(c.frames, "task_started");
  assert.equal(started.length, 2);
  assert.equal(started[0].tool_use_id, agents[0].id);
  assert.equal(started[0].task_type, "local_agent");
  assert.equal(started[0].is_backgrounded, false);
  // child frames: prompt (user text), Read tool_use + tool_result, final text; all with parent_tool_use_id = Agent id
  const childUses = uses.filter((u) => u.parent === agents[0].id);
  assert.deepEqual(childUses.map((u) => u.name), ["Read"]);
  assert.ok(toolResults(c.frames).some((r) => r.parent === agents[0].id && /greet/.test(JSON.stringify(r.content))));
  assert.match(texts(c.frames, agents[0].id).join(""), /not called anywhere else/);
  assert.ok(c.frames.some((f) => f.type === "user" && f.parent_tool_use_id === agents[0].id && f.message.content[0]?.text?.startsWith("Find where greet")));
  // second child ran Bash
  assert.deepEqual(uses.filter((u) => u.parent === agents[1].id).map((u) => u.name), ["Bash"]);
  assert.equal(sys(c.frames, "task_progress").filter((f) => f.task_id === started[0].task_id).length, 1);
  const notes = sys(c.frames, "task_notification");
  assert.equal(notes[0].status, "completed");
  assert.match(notes[0].summary, /not called anywhere else/);
  // the Agent tool_result is a root-level tool_result with the child's text
  const res = toolResults(c.frames).find((r) => r.tool_use_id === agents[0].id);
  assert.equal(res.parent, null);
  assert.match(res.content[0].text, /not called anywhere else/);
  assert.equal(res.structured.status, "completed");
  // root text: parent null, never a child's text
  assert.doesNotMatch(texts(c.frames).join(""), /not called anywhere else\.$/);
  assert.match(texts(c.frames).join(""), /Both workers finished/);
});

test("background Bash: run_in_background + roster + task_started, then (after the turn) task_notification and a wake turn", async () => {
  const c = client();
  c.user("[mock:background-bash]");
  await c.result();
  const bash = toolUses(c.frames).find((u) => u.name === "Bash");
  assert.equal(bash.input.run_in_background, true);
  const started = sys(c.frames, "task_started")[0];
  assert.equal(started.task_type, "local_bash");
  assert.equal(started.is_backgrounded, true);
  assert.equal(started.tool_use_id, bash.id);
  const roster = sys(c.frames, "background_tasks_changed")[0];
  assert.deepEqual(roster.tasks.map((t) => [t.task_id, t.task_type, t.description]), [[started.task_id, "local_bash", "Run the build"]]);
  const ack = toolResults(c.frames).find((r) => r.tool_use_id === bash.id);
  assert.match(ack.content, /running in background with ID/);
  assert.equal(ack.structured.backgroundTaskId, started.task_id);
  // order inside the turn: tool_use, roster, task_started, tool_result
  const idx = (pred) => c.frames.findIndex(pred);
  assert.ok(idx((f) => f.subtype === "background_tasks_changed") < idx((f) => f.subtype === "task_started"));
  // completion: roster [] + task_updated + task_notification, wake turn (init, assistant, result) without a user message
  await c.result(2);
  const note = sys(c.frames, "task_notification")[0];
  assert.equal(note.status, "completed");
  assert.match(note.summary, /Background command "Run the build" completed \(exit code 0\)/);
  assert.deepEqual(sys(c.frames, "background_tasks_changed").at(-1).tasks, []);
  assert.equal(sys(c.frames, "task_updated")[0].patch.status, "completed");
  const resultIdx = c.frames.map((f, i) => (f.type === "result" ? i : -1)).filter((i) => i >= 0);
  assert.ok(idx((f) => f.subtype === "task_notification") > resultIdx[0], "notification arrives after the first result");
  assert.ok(sys(c.frames, "init").length >= 2, "wake turn starts with init");
  assert.match(texts(c.frames).at(-1), /Run the build finished \(exit 0\)\. Last line: build finished/);
  assert.equal(c.frames.filter((f) => f.type === "result")[1].user_message_uuid, undefined);
});

test("background Monitor (persistent): Monitor tool_use + started ack; hold gate keeps the completion report back", async () => {
  const c = client();
  c.user("[mock:background-task until=g1]");
  await c.result();
  const mon = toolUses(c.frames).find((u) => u.name === "Monitor");
  assert.equal(mon.input.persistent, true);
  assert.match(toolResults(c.frames).find((r) => r.tool_use_id === mon.id).content, /Monitor started \(task b[0-9a-f]{8}/);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sys(c.frames, "task_notification").length, 0, "held until the gate is released");
  mkdirSync(join(c.cwd, ".ctl/release"), { recursive: true });
  writeFileSync(join(c.cwd, ".ctl/release/g1"), "1");
  await c.result(2);
  assert.match(sys(c.frames, "task_notification")[0].summary, /^Monitor "Watch the dev server" stream ended$/);
  assert.match(texts(c.frames).at(-1), /Watch the dev server finished \(exit 0\)\. Last line: dev server listening/);
});

test("background TaskOutput + TaskStop: output tool row, stop kills the task, no wake turn", async () => {
  const c = client();
  c.user("[mock:background-bash mode=stop]");
  await c.result();
  const names = toolUses(c.frames).map((u) => u.name);
  assert.deepEqual(names, ["Bash", "TaskOutput", "TaskStop"]);
  const out = toolResults(c.frames).find((r) => r.tool_use_id === toolUses(c.frames)[1].id);
  assert.match(out.content, /<status>running<\/status>/);
  assert.match(out.content, /watcher started/);
  const stop = sys(c.frames, "task_notification")[0];
  assert.equal(stop.status, "stopped");
  assert.equal(sys(c.frames, "task_updated")[0].patch.status, "killed");
  assert.deepEqual(sys(c.frames, "background_tasks_changed").at(-1).tasks, []);
  const stopRes = toolResults(c.frames).find((r) => r.tool_use_id === toolUses(c.frames)[2].id);
  assert.match(stopRes.content, /Successfully stopped task: b[0-9a-f]{8}/);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(c.frames.filter((f) => f.type === "result").length, 1, "a stopped task does not wake the session");
});

test("hooks: hook_started + hook_response pairs with matching hook_id, turn unaffected", async () => {
  const c = client();
  c.user("[mock:hooks]");
  const r = await c.result();
  assert.equal(r.is_error, false);
  const started = sys(c.frames, "hook_started");
  const resp = sys(c.frames, "hook_response");
  assert.equal(started.length, 4);
  assert.deepEqual(resp.map((x) => x.hook_id), started.map((x) => x.hook_id));
  assert.deepEqual(started.map((x) => x.hook_event), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
  assert.equal(resp[2].output, "pre-tool hook ok");
  assert.equal(resp[0].outcome, "success");
});

test("MCP tool calls: mcp__server__tool names + tool_use_meta, servers listed in init + mcp_status", async () => {
  const c = client();
  c.user("[mock:mcp-tools]");
  await c.result();
  const calls = c.frames.filter((f) => f.type === "assistant" && f.message.content[0]?.type === "tool_use");
  assert.deepEqual(calls.map((f) => f.message.content[0].name), ["mcp__linear__list_issues", "mcp__docs__search_docs"]);
  assert.deepEqual(calls[0].tool_use_meta, [{ id: calls[0].message.content[0].id, display_name: "List issues", server_display_name: "Linear" }]);
  assert.match(toolResults(c.frames)[0].content, /MOCK-12/);
  // second turn: the init frame now lists the servers the session used
  c.user("hello");
  await c.result(2);
  const init = sys(c.frames, "init").at(-1);
  assert.deepEqual(init.mcp_servers.map((s) => s.name).sort(), ["docs", "linear"]);
  const status = await new Promise((resolve) => {
    c.send({ type: "control_request", request_id: "r1", request: { subtype: "mcp_status" } });
    c.waitFor((f) => f.type === "control_response" && f.response.request_id === "r1").then(resolve);
  });
  assert.deepEqual(status.response.response.mcpServers.map((s) => s.name).sort(), ["docs", "linear"]);
});

test("WebSearch + WebFetch: tool_use names/inputs, search results with links + durationSeconds, fetch body", async () => {
  const c = client();
  c.user("[mock:web-fetch]");
  await c.result();
  const uses = toolUses(c.frames);
  assert.deepEqual(uses.map((u) => u.name), ["WebSearch", "WebFetch"]);
  assert.deepEqual(uses[0].input, { query: "vite build.outDir default" });
  assert.equal(uses[1].input.url, "https://vite.dev/config/build-options.html");
  const [search, fetched] = toolResults(c.frames);
  assert.equal(search.structured.query, "vite build.outDir default");
  assert.equal(typeof search.structured.durationSeconds, "number");
  assert.deepEqual(search.structured.results[0].content[0], { title: "Build Options | Vite", url: "https://vite.dev/config/build-options.html" });
  assert.match(search.content, /^Web search results for query: "vite build.outDir default"/);
  assert.match(fetched.content, /build\.outDir: Specify the output directory/);
  assert.equal(fetched.structured.code, 200);
});

test("/compact: status compacting -> compact_boundary + synthetic summary + local_command result; later turns start from the post-compact context", async () => {
  const c = client();
  c.user("hello there");
  const first = await c.result();
  const before = first.usage.input_tokens;
  c.user("/compact");
  const r = await c.result(2);
  assert.equal(r.local_command, "compact");
  assert.equal(r.result, "");
  assert.equal(r.is_error, false);
  const status = sys(c.frames, "status");
  assert.equal(status[0].status, "compacting");
  assert.equal(status[1].status, null);
  assert.equal(status[1].compact_result, "success");
  const cb = sys(c.frames, "compact_boundary")[0];
  assert.equal(cb.compact_metadata.trigger, "manual");
  assert.ok(cb.compact_metadata.pre_tokens > cb.compact_metadata.post_tokens);
  assert.equal(cb.compact_metadata.post_tokens, 1192);
  assert.ok(c.frames.some((f) => f.type === "user" && f.isSynthetic === true && /Summary:/.test(f.message.content)));
  assert.ok(c.frames.some((f) => f.type === "user" && f.message.content === "<local-command-stdout>Compacted </local-command-stdout>"));
  // the compaction did not count as a turn; the next turn's context is small again
  c.user("after compaction");
  const third = await c.result(3);
  assert.match(texts(c.frames).at(-1), /turn 2\. You said: "after compaction"/);
  assert.ok(third.usage.input_tokens < before + 400, `post-compact input ${third.usage.input_tokens} should restart from the compacted base (before ${before})`);
});

test("/compact pinned by a queued hold gate; auto compaction inside a turn keeps the turn going", async () => {
  const c = client();
  c.user("[mock:compact-auto]");
  await c.result();
  assert.equal(sys(c.frames, "compact_boundary")[0].compact_metadata.trigger, "auto");
  assert.equal(sys(c.frames, "compact_boundary")[0].compact_metadata.pre_tokens, 168000);
  assert.match(texts(c.frames).join(""), /continuing with the remaining edits/);
});

test("skills: init lists workspace skills; `/name args` runs the skill-run scenario (Skill tool + SKILL.md read)", async () => {
  const cwd = workspace();
  mkdirSync(join(cwd, ".claude/skills/release-notes"), { recursive: true });
  writeFileSync(join(cwd, ".claude/skills/release-notes/SKILL.md"), "---\nname: release-notes\ndescription: Draft release notes from the git log\n---\n\nSummarize commits.\n");
  const c = client({ cwd });
  c.user("/release-notes v1.2");
  await c.result();
  const init = sys(c.frames, "init")[0];
  assert.deepEqual(init.skills, ["release-notes"]);
  assert.ok(init.slash_commands.includes("release-notes"));
  const uses = toolUses(c.frames);
  assert.deepEqual(uses[0], { ...uses[0], name: "Skill", input: { skill: "release-notes", args: "v1.2" } });
  assert.equal(toolResults(c.frames)[0].content, "Launching skill: release-notes");
  assert.equal(uses[1].name, "Read");
  assert.match(uses[1].input.file_path, /\.claude\/skills\/release-notes\/SKILL\.md$/);
  assert.match(texts(c.frames).join(""), /release-notes skill finished: Draft release notes from the git log/);
  // an unknown `/thing` is not a skill: plain echo turn
  c.user("/unknown-thing");
  await c.result(2);
  assert.match(texts(c.frames).at(-1), /Mock agent, turn 2/);
});

test("rewind: respawn with --resume + --resume-session-at drops later turns (turn counter + history)", async () => {
  const cwd = workspace();
  const sid = "55555555-5555-4555-8555-555555555555";
  const a = client({ cwd, args: [`--session-id=${sid}`] });
  for (let i = 1; i <= 3; i++) {
    a.user(`question ${i}`);
    await a.result(i);
  }
  const cursors = a.frames.filter((f) => f.type === "assistant" && !f.parent_tool_use_id).map((f) => f.uuid);
  assert.equal(cursors.length, 3);
  a.close();
  await new Promise((r) => a.p.on("exit", r));
  // T3 closes the CLI and respawns it resumed at turn 2's assistant message
  const b = client({ cwd, args: [`--resume=${sid}`, `--resume-session-at=${cursors[1]}`] });
  b.user("fresh question");
  await b.result();
  const text = texts(b.frames).at(-1);
  assert.match(text, /turn 3\. You said: "fresh question"/);
  assert.match(text, /Your previous message was: "question 2"/);
  // without the cursor the counter keeps going
  const c2 = client({ cwd, args: [`--resume=${sid}`] });
  c2.user("again");
  await c2.result();
  assert.match(texts(c2.frames).at(-1), /turn 4\./);
});

test("image blocks: PNG header decoded (media type, pixel size, bytes) and answered", async () => {
  const c = client();
  c.send({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } }, { type: "text", text: "[mock:image-input] what is this?" }] }, parent_tool_use_id: null });
  await c.result();
  assert.match(texts(c.frames).join(""), /I received 1 image:[\s\S]*1\. image\/png, 1x1 px, 70 bytes/);
});

test("Read of an image file returns an image block in the tool_result", async () => {
  const c = client();
  c.user("[mock:image-read]");
  await c.result();
  const res = toolResults(c.frames)[0];
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].source.media_type, "image/png");
  assert.equal(res.content[0].source.data, PNG_1X1);
  assert.equal(res.structured.type, "image");
  assert.match(toolUses(c.frames)[0].input.file_path, /assets\/logo\.png$/);
});

test("api_retry system frames (provider-retry scenario) and informational notices", async () => {
  const c = client();
  c.user("[mock:provider-retry]");
  await c.result();
  const retries = sys(c.frames, "api_retry");
  assert.deepEqual(retries.map((r) => [r.attempt, r.max_retries]), [[1, 5], [2, 5]]);
  assert.equal(retries[0].error_status, 529);
  c.user("[mock:notice]");
  await c.result(2);
  const n = sys(c.frames, "informational")[0];
  assert.equal(n.level, "warning");
  assert.match(n.content, /fallback model/);
});

test("toolFor: MCP identity, native name override, fetch kind", () => {
  assert.deepEqual(toolFor({ kind: "other", title: "x", server: "Linear Inc", name: "list issues", input: { a: 1 } }), { name: "mcp__linear_inc__list_issues", input: { a: 1 } });
  assert.deepEqual(toolFor({ kind: "other", title: "Find files", name: "Glob", input: { pattern: "*.ts" } }), { name: "Glob", input: { pattern: "*.ts" } });
  assert.equal(toolFor({ kind: "fetch", title: "t", input: { url: "https://e.invalid" } }).name, "WebFetch");
  assert.equal(toolFor({ kind: "fetch", title: "t", input: { query: "q" } }).name, "WebSearch");
});

test("IR degrade: adapters without the Claude ops fall back to plain tool calls / say / no-ops", async () => {
  const events = [];
  const sink = { message: (t) => events.push(["say", t]), thought() {}, toolStart: (x) => events.push(["tool", x.title]), toolUpdate() {}, plan() {}, permission: async () => "allow", ask: async () => ({ answers: {} }) };
  const ctx = { cwd: process.cwd(), env: process.env, signal: undefined, pace: { chunkWords: 100, chunkMs: () => 0, toolMs: 0 }, nextToolId: (() => { let n = 0; return () => `t${++n}`; })(), log: undefined };
  await runSteps([S.skill("demo", { args: "x" }), S.hook("PreToolUse"), S.compact({ summary: "compacted" }), S.notice("heads up"), S.bgControl("stop"), S.web("q", { fetch: true, url: "https://e.invalid" })], sink, ctx);
  assert.deepEqual(events, [["tool", "Skill demo"], ["say", "compacted"], ["say", "heads up"], ["tool", "Fetch https://e.invalid"]]);
});
