// node --test mockkit/test  (no T3 needed). Drives the ACP agent over stdio like the T3 server does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dequeue, enqueue } from "../lib/queue.mjs";
import { safeName } from "../lib/hold.mjs";

const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/t3-mock-acp.mjs");

function client(env = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "mk-ws-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/greeting.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "README.md"), "# hi\n");
  writeFileSync(join(cwd, "package.json"), "{}\n");
  const p = spawn(process.execPath, [bin], {
    env: { ...process.env, MOCK_PACE: "fast", MOCK_CONTROL_DIR: join(cwd, ".ctl"), ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
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
      const f = JSON.parse(line);
      frames.push(f);
      waiters.slice().forEach((w) => w());
    }
  });
  let id = 0;
  const send = (o) => p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
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
  const request = async (method, params) => {
    const my = ++id;
    send({ id: my, method, params });
    return waitFor((f) => f.id === my && f.method === undefined);
  };
  return { p, frames, send, request, waitFor, cwd, close: () => p.stdin.end() };
}

const text = (frames) =>
  frames
    .filter((f) => f.method === "session/update" && f.params.update.sessionUpdate === "agent_message_chunk")
    .map((f) => f.params.update.content.text)
    .join("");

const wrap = (t) => [{ type: "text", text: `<t3_code_instructions>\nx\n</t3_code_instructions>\n\n<user_request>\n${t}\n</user_request>` }];

async function session(c, clientName = "t3-code") {
  const init = await c.request("initialize", { protocolVersion: 2, clientInfo: { name: clientName, version: "0" } });
  assert.equal(init.result.protocolVersion, 1);
  assert.ok(init.result._meta.modelState.availableModels.length > 0);
  const ns = await c.request("session/new", { cwd: c.cwd, mcpServers: [] });
  return ns.result.sessionId;
}

test("initialize + session/new advertise models", async () => {
  const c = client();
  const sid = await session(c);
  assert.ok(sid);
  c.close();
});

test("echo default + multi-turn counts turns", async () => {
  const c = client();
  const sid = await session(c);
  let r = await c.request("session/prompt", { sessionId: sid, prompt: wrap("hello there") });
  assert.equal(r.result.stopReason, "end_turn");
  assert.match(text(c.frames), /turn 1.*hello there/);
  r = await c.request("session/prompt", { sessionId: sid, prompt: wrap("second") });
  assert.match(text(c.frames), /turn 2.*second.*previous message was: "hello there"/);
  c.close();
});

test("[mock:markdown-stream] under <user_request> wrapper", async () => {
  const c = client();
  const sid = await session(c);
  await c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:markdown-stream] hi") });
  const t = text(c.frames);
  assert.match(t, /\| Provider \| Kind/);
  assert.match(t, /```ts/);
  c.close();
});

test("edit-file-diff does a REAL write and emits edit tool with diff", async () => {
  const c = client();
  const sid = await session(c);
  await c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:edit-file-diff] go") });
  assert.match(readFileSync(join(c.cwd, "src/greeting.ts"), "utf8"), /Welcome aboard/);
  assert.match(readFileSync(join(c.cwd, "src/farewell.ts"), "utf8"), /Goodbye/);
  const diffs = c.frames.filter((f) => f.params?.update?.content?.some?.((x) => x.type === "diff"));
  assert.ok(diffs.length >= 2);
  c.close();
});

test("approval-allow blocks on session/request_permission and writes after allow", async () => {
  const c = client();
  const sid = await session(c);
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:approval-allow] x") });
  const req = await c.waitFor((f) => f.method === "session/request_permission");
  assert.equal(req.params.toolCall.kind, "edit");
  assert.ok(req.params.options.some((o) => o.kind === "allow_once"));
  assert.throws(() => readFileSync(join(c.cwd, "NOTES.md")));
  c.send({ id: req.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  const r = await done;
  assert.equal(r.result.stopReason, "end_turn");
  assert.match(readFileSync(join(c.cwd, "NOTES.md"), "utf8"), /mock agent/);
  c.close();
});

test("approval reject skips the write", async () => {
  const c = client();
  const sid = await session(c);
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:approval-allow] x") });
  const req = await c.waitFor((f) => f.method === "session/request_permission");
  c.send({ id: req.id, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
  await done;
  assert.throws(() => readFileSync(join(c.cwd, "NOTES.md")));
  assert.match(text(c.frames), /will not write/);
  c.close();
});

test("error-turn returns a JSON-RPC error with data.message", async () => {
  const c = client();
  const sid = await session(c);
  const r = await c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:error-turn] x") });
  assert.equal(r.error.code, -32603);
  assert.match(r.error.data.message, /mock failure/);
  c.close();
});

test("cancel aborts a held turn -> stopReason cancelled", async () => {
  const c = client();
  const sid = await session(c);
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:slow hold=rec] x") });
  await new Promise((r) => setTimeout(r, 400));
  c.send({ method: "session/cancel", params: { sessionId: sid } });
  const r = await done;
  assert.equal(r.result.stopReason, "cancelled");
  c.close();
});

test("hold gate releases via sentinel file", async () => {
  const c = client();
  const sid = await session(c);
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:slow hold=g1] x") });
  await new Promise((r) => setTimeout(r, 400));
  mkdirSync(join(c.cwd, ".ctl/release"), { recursive: true });
  writeFileSync(join(c.cwd, ".ctl/release/g1"), "1");
  const r = await done;
  assert.equal(r.result.stopReason, "end_turn");
  assert.match(text(c.frames), /Finished the long task/);
  c.close();
});

test("text-generation session never runs a scenario; returns JSON", async () => {
  const c = client();
  const sid = await session(c, "t3-code-git-text");
  const prompt = `Generate a title.\nReturn JSON with keys title and needsRefinement.\n\nUser message:\n[mock:approval-allow] please do stuff`;
  const r = await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: prompt }] });
  assert.equal(r.result.stopReason, "end_turn");
  const j = JSON.parse(text(c.frames));
  assert.equal(j.title, "Approval request");
  assert.equal(j.needsRefinement, false);
  assert.equal(c.frames.filter((f) => f.method === "session/request_permission").length, 0);
  c.close();
});

test("commit-message prompt answered by schema keys even without clientInfo hint", async () => {
  const c = client();
  const sid = await session(c, "other");
  const prompt = `You write commit messages.\nReturn a JSON object with keys: subject, body.\nStaged patch: ...`;
  await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: prompt }] });
  const j = JSON.parse(text(c.frames));
  assert.ok(j.subject && typeof j.body === "string");
  c.close();
});

test("follow-up turn: <runtime_info> suffix is stripped before echo/selection", async () => {
  const c = client();
  const sid = await session(c);
  await c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "second message <runtime_info>In case you're asked: you are X.</runtime_info>" }] });
  const t = text(c.frames);
  assert.match(t, /You said: "second message"\./);
  assert.doesNotMatch(t, /runtime_info/);
  c.close();
});

test("shell step reports stdout + exitCode via rawOutput (what T3 projects as command output)", async () => {
  const c = client();
  const sid = await session(c);
  await c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:shell] go") });
  const done = c.frames.filter((f) => f.params?.update?.sessionUpdate === "tool_call_update" && f.params.update.status === "completed").at(-1);
  assert.match(done.params.update.rawOutput.stdout, /build finished/);
  assert.equal(done.params.update.rawOutput.exitCode, 0);
  c.close();
});

test("hidden routing: queued scenario runs with a natural prompt (no [mock:] tag)", async () => {
  const c = client();
  const sid = await session(c);
  const env = { MOCK_CONTROL_DIR: join(c.cwd, ".ctl") };
  enqueue("markdown-stream", {}, { cwd: c.cwd, env });
  await c.request("session/prompt", { sessionId: sid, prompt: wrap("Show me a markdown demo") });
  assert.match(text(c.frames), /\| Provider \| Kind/);
  const n = c.frames.length;
  // queue consumed: the next untagged turn falls back to echo
  await c.request("session/prompt", { sessionId: sid, prompt: wrap("and now?") });
  assert.match(text(c.frames.slice(n)), /turn 2.*and now\?/);
  c.close();
});

test("hidden routing: queue is per cwd, FIFO, and an explicit tag wins without consuming it", async () => {
  const c = client();
  const sid = await session(c);
  const env = { MOCK_CONTROL_DIR: join(c.cwd, ".ctl") };
  enqueue("error-turn", {}, { cwd: "/nonexistent-other-ws", env });
  enqueue("markdown-stream", {}, { cwd: c.cwd, env });
  enqueue("error-turn", {}, { cwd: c.cwd, env });
  await c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:echo] tagged") });
  assert.match(text(c.frames), /turn 1.*tagged/); // tag wins, queue untouched
  let r = await c.request("session/prompt", { sessionId: sid, prompt: wrap("hi") });
  assert.equal(r.result.stopReason, "end_turn");
  assert.match(text(c.frames), /\| Provider \| Kind/); // first queued entry for THIS cwd
  r = await c.request("session/prompt", { sessionId: sid, prompt: wrap("hi again") });
  assert.equal(r.error.code, -32603); // second entry (error-turn)
  assert.equal(dequeue("/nonexistent-other-ws", env)?.id, "error-turn"); // other cwd's entry untouched
  c.close();
});

test("hidden routing: queue args reach the scenario (slow hold=<name>)", async () => {
  const c = client();
  const sid = await session(c);
  const env = { MOCK_CONTROL_DIR: join(c.cwd, ".ctl") };
  enqueue("slow", { hold: "gate1" }, { cwd: c.cwd, env });
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("go") });
  await new Promise((r) => setTimeout(r, 500));
  c.send({ method: "session/cancel", params: { sessionId: sid } });
  assert.equal((await done).result.stopReason, "cancelled");
  assert.ok(readFileSync(join(c.cwd, ".ctl/reached/gate1"), "utf8"));
  c.close();
});

test("hold names are sanitized (no path traversal)", () => {
  assert.ok(!safeName("../../etc/passwd").includes("/"));
  assert.ok(!safeName("..").startsWith("."));
  assert.equal(safeName("rec"), "rec");
});

test("exit-plan scenario sends an _x.ai/exit_plan_mode request with the plan markdown", async () => {
  const c = client();
  const sid = await session(c);
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:exit-plan]") });
  const req = await c.waitFor((f) => f.method === "_x.ai/exit_plan_mode");
  assert.equal(req.params.method, "x.ai/exit_plan_mode");
  assert.equal(req.params.params.sessionId, sid);
  assert.match(req.params.params.planContent, /^# Refactor the greeting helper/);
  c.send({ id: req.id, result: { outcome: "abandoned", feedback: "captured" } });
  const r = await done;
  assert.equal(r.result.stopReason, "end_turn");
  assert.match(text(c.frames), /plan is ready for your review/);
  c.close();
});

test("approval-deny: rejecting runs onReject and never executes the command", async () => {
  const c = client();
  const sid = await session(c);
  mkdirSync(join(c.cwd, "dist"));
  writeFileSync(join(c.cwd, "dist/keep.txt"), "x");
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:approval-deny]") });
  const req = await c.waitFor((f) => f.method === "session/request_permission");
  assert.equal(req.params.toolCall.kind, "execute");
  c.send({ id: req.id, result: { outcome: { outcome: "selected", optionId: "reject-once" } } });
  assert.equal((await done).result.stopReason, "end_turn");
  assert.match(text(c.frames), /leave `dist` untouched/);
  assert.equal(readFileSync(join(c.cwd, "dist/keep.txt"), "utf8"), "x"); // rm never ran
  c.close();
});

test("todo scenario starts with a six-entry plan (first entry in progress)", async () => {
  const c = client();
  const sid = await session(c);
  const done = c.request("session/prompt", { sessionId: sid, prompt: wrap("[mock:todo]") });
  const plan = await c.waitFor((f) => f.method === "session/update" && f.params.update.sessionUpdate === "plan");
  assert.equal(plan.params.update.entries.length, 6);
  assert.equal(plan.params.update.entries[0].status, "in_progress");
  c.send({ method: "session/cancel", params: { sessionId: sid } });
  assert.equal((await done).result.stopReason, "cancelled");
  c.close();
});
