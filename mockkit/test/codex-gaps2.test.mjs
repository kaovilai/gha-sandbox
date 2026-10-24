// node --test mockkit/test  Codex gaps 2 (track codex-gaps-2): background terminals (+ list/terminate, thread/closed, wake), dynamicToolCall,
// async questions, subAgentActivity (+ thread/settings/updated, model/rerouted), raw reasoning, interactive MCP app data
// (mcpServerStatus/list + mcpServer/tool/call), feedback/upload, account state shared across processes. Same stdio harness as codex-gaps.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { release } from "../ctl/mockctl.mjs";
import { S, runSteps } from "../lib/ir.mjs";
import { loadScenarios } from "../scenarios/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/t3-mock-codex.mjs");

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "mk-cx3-ws-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/greeting.ts"), "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(cwd, "package.json"), '{"scripts":{"build":"tsc"}}\n');
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

function client({ cwd = workspace(), env = {} } = {}) {
  const ctl = join(cwd, ".ctl");
  const p = spawn(process.execPath, [bin, "app-server"], {
    env: { ...process.env, MOCK_PACE: "fast", MOCK_CONTROL_DIR: ctl, ...env },
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
      frames.push(JSON.parse(line));
      waiters.slice().forEach((w) => w());
    }
  });
  let id = 0;
  const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
  const waitFor = (pred, ms = 15_000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for frame; last frames: ${JSON.stringify(frames.slice(-6).map((f) => f.method ?? `#${f.id}`))}`)), ms);
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
  const request = (method, params) => {
    const my = ++id;
    send({ id: my, method, params });
    return waitFor((f) => f.id === my && f.method === undefined);
  };
  const note = (method, pred = () => true) => waitFor((f) => f.method === method && f.id === undefined && pred(f.params));
  return { p, frames, send, request, waitFor, note, cwd, ctl, close: () => p.stdin.end() };
}

async function boot(c) {
  await c.request("initialize", { clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" }, capabilities: { experimentalApi: true } });
  c.send({ method: "initialized" });
}
const startThread = async (c) => (await c.request("thread/start", { cwd: c.cwd, model: "gpt-6-astra" })).result.thread.id;
const turnParams = (threadId, cwd, text, approvalPolicy = "never") => ({ threadId, cwd, model: "gpt-6-astra", approvalPolicy, input: [{ type: "text", text, text_elements: [] }] });
const methods = (frames, m, pred = () => true) => frames.filter((f) => f.method === m && pred(f.params));
const agentText = (frames, threadId) =>
  frames
    .filter((f) => f.method === "item/agentMessage/delta" && (!threadId || f.params.threadId === threadId))
    .map((f) => f.params.delta)
    .join("");

test("bg-terminal: the command item outlives its turn, shows in backgroundTerminals/list, completes after the gate with the output", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:bg-terminal until=bg1] go"));
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  const started = c.frames.find((f) => f.method === "item/started" && f.params.item.type === "commandExecution");
  assert.ok(started, "command item started");
  assert.equal(started.params.item.status, "inProgress");
  assert.match(started.params.item.command, /dev server listening/);
  const procId = started.params.item.processId;
  assert.ok(procId, "processId lets T3 terminate it");
  assert.ok(!c.frames.some((f) => f.method === "item/completed" && f.params.item.type === "commandExecution"), "still running when the turn ended");
  // live output arrives after the turn completed
  await c.waitFor((f) => f.method === "item/commandExecution/outputDelta" && /listening/.test(f.params.delta));
  const list = (await c.request("thread/backgroundTerminals/list", { threadId })).result;
  assert.deepEqual(list.data.map((d) => d.processId), [procId]);
  // the shell exits after ~3 s; the gate keeps the completion back until released
  await c.waitFor((f) => f.method === "item/commandExecution/outputDelta" && /idle timeout/.test(f.params.delta), 15_000);
  assert.ok(!c.frames.some((f) => f.method === "item/completed" && f.params.item.type === "commandExecution"), "gate holds the completion");
  release("bg1", { MOCK_CONTROL_DIR: c.ctl });
  const comp = await c.waitFor((f) => f.method === "item/completed" && f.params.item.type === "commandExecution");
  assert.equal(comp.params.turnId, done.params.turn.id, "completion carries the ORIGINAL turn id (T3 matches its settled context)");
  assert.equal(comp.params.item.status, "completed");
  assert.equal(comp.params.item.exitCode, 0);
  assert.match(comp.params.item.aggregatedOutput, /dev server stopped/);
  assert.deepEqual((await c.request("thread/backgroundTerminals/list", { threadId })).result.data, []);
  c.close();
});

test("bg-terminal: terminate kills the process and fails the item; unknown process is not terminated", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:bg-terminal close=1 until=bg2] go"));
  await c.note("turn/completed");
  const procId = c.frames.find((f) => f.method === "item/started" && f.params.item.type === "commandExecution").params.item.processId;
  assert.deepEqual((await c.request("thread/backgroundTerminals/terminate", { threadId, processId: "nope" })).result, { terminated: false });
  assert.deepEqual((await c.request("thread/backgroundTerminals/terminate", { threadId, processId: procId })).result, { terminated: true });
  const comp = await c.waitFor((f) => f.method === "item/completed" && f.params.item.type === "commandExecution");
  assert.equal(comp.params.item.status, "failed");
  assert.equal(comp.params.item.exitCode, 143);
  assert.deepEqual((await c.request("thread/backgroundTerminals/list", { threadId })).result.data, []);
  c.close();
});

test("bg-terminal close=1: the gate unloads the thread (thread/closed) and the item never completes", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:bg-terminal close=1 until=bg3] go"));
  await c.note("turn/completed");
  assert.equal(methods(c.frames, "thread/closed").length, 0);
  release("bg3", { MOCK_CONTROL_DIR: c.ctl });
  const closed = await c.note("thread/closed");
  assert.equal(closed.params.threadId, threadId);
  assert.ok(!c.frames.some((f) => f.method === "item/completed" && f.params.item.type === "commandExecution"), "no completion for a killed terminal");
  assert.deepEqual((await c.request("thread/backgroundTerminals/list", { threadId })).result.data, []);
  c.close();
});

test("bg-wake: the continuation message T3 sends is quoted back", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:bg-wake] Background command completed (exit 0): /bin/bash -lc 'node server.js'\n\nOutput tail:\nbye"));
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /T3 reported: "Background command completed \(exit 0\)/);
  c.close();
});

test("dynamic-tool: dynamicToolCall items (namespace, arguments, contentItems, success) incl. a failure", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:dynamic-tool] go"));
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  const started = methods(c.frames, "item/started", (p) => p.item.type === "dynamicToolCall").map((f) => f.params.item);
  assert.equal(started.length, 3);
  assert.equal(started[0].status, "inProgress");
  const completed = methods(c.frames, "item/completed", (p) => p.item.type === "dynamicToolCall").map((f) => f.params.item);
  assert.deepEqual(completed.map((i) => `${i.namespace}.${i.tool}:${i.status}:${i.success}`), ["node_repl.js:completed:true", "acme_docs.lookup:completed:true", "acme_docs.lookup:failed:false"]);
  assert.equal(completed[0].arguments.title, "Check bundle size");
  assert.deepEqual(completed[0].contentItems, [{ type: "inputText", text: "dist/app.js: 48213 bytes" }]);
  c.close();
});

test("async-ask: agentMessage delivery async carries the questions; the turn ends; the answer is a normal turn", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:async-ask] migrate"));
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed", "turn does not wait for the answer");
  const asyncMsg = methods(c.frames, "item/completed", (p) => p.item.type === "agentMessage" && p.item.delivery === "async")[0].params.item;
  assert.deepEqual(asyncMsg.questions, [
    { title: "Which database should the migration target?", options: ["PostgreSQL", "SQLite"] },
    { title: "Run the migration automatically on deploy?", options: ["Yes", "No"] },
  ]);
  assert.ok(!c.frames.some((f) => f.method === "item/tool/requestUserInput" || (f.id !== undefined && f.method)), "no blocking server request");
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:async-ask phase=answer] PostgreSQL, Yes"));
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /You said: PostgreSQL, Yes/);
  c.close();
});

test("subagent-activity: subAgentActivity started/completed items (agentPath), child settings + reroute, child turns on child ids", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:subagent-activity] go"));
  const done = await c.note("turn/completed", (p) => p.threadId === threadId);
  assert.equal(done.params.turn.status, "completed");
  const acts = c.frames.filter((f) => (f.method === "item/started" || f.method === "item/completed") && f.params.item.type === "subAgentActivity");
  const completedActs = acts.filter((f) => f.method === "item/completed").map((f) => `${f.params.item.agentPath}:${f.params.item.kind}`);
  assert.deepEqual(completedActs, ["/root/explorer:started", "/root/explorer:completed", "/root/builder:started", "/root/builder:completed"]);
  assert.ok(acts.every((f) => f.params.threadId === threadId), "activity items belong to the parent turn");
  assert.ok(!c.frames.some((f) => f.params?.item?.type === "collabAgentToolCall"), "activity protocol replaces the collab items");
  const childIds = new Set(acts.map((f) => f.params.item.agentThreadId));
  assert.equal(childIds.size, 2);
  const [explorer, builder] = [...childIds];
  // children announced + ran their own turns
  for (const id of childIds) {
    assert.ok(methods(c.frames, "thread/started", (p) => p.thread.id === id && p.thread.parentThreadId === threadId).length >= 1, "child thread/started with parent");
    assert.ok(methods(c.frames, "turn/completed", (p) => p.threadId === id).length === 1);
  }
  assert.match(agentText(c.frames, explorer), /nothing else calls it/);
  assert.match(agentText(c.frames, builder), /runs `tsc`/);
  const settings = methods(c.frames, "thread/settings/updated")[0].params;
  assert.equal(settings.threadId, explorer);
  assert.equal(settings.threadSettings.model, "gpt-6-luna");
  assert.equal(settings.threadSettings.effort, "low");
  assert.equal(settings.threadSettings.collaborationMode.mode, "default");
  const rer = methods(c.frames, "model/rerouted")[0].params;
  assert.equal(rer.threadId, builder);
  assert.equal(rer.toModel, "gpt-5.6-sol");
  assert.equal(rer.reason, "highRiskCyberActivity");
  assert.ok(rer.turnId);
  c.close();
});

test("subagent-spawn (collab protocol) still works and carries reasoningEffort when given", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:subagent-spawn] go"));
  await c.note("turn/completed", (p) => p.threadId === threadId);
  assert.ok(c.frames.some((f) => f.method === "item/completed" && f.params.item.type === "collabAgentToolCall" && f.params.item.tool === "spawnAgent"));
  assert.ok(!c.frames.some((f) => f.params?.item?.type === "subAgentActivity"));
  c.close();
});

test("raw-reasoning: item/reasoning/textDelta streams into reasoning.content (summary stays separate)", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:raw-reasoning] go"));
  await c.note("turn/completed");
  const rawDeltas = methods(c.frames, "item/reasoning/textDelta");
  assert.ok(rawDeltas.length > 0);
  assert.ok(rawDeltas.every((f) => f.params.contentIndex === 0 && f.params.itemId));
  assert.match(rawDeltas.map((f) => f.params.delta).join(""), /explicit stack keeps memory flat/);
  const summ = methods(c.frames, "item/reasoning/summaryTextDelta").map((f) => f.params.delta).join("");
  assert.match(summ, /Summary: weigh/);
  const items = methods(c.frames, "item/completed", (p) => p.item.type === "reasoning").map((f) => f.params.item);
  assert.equal(items.length, 2, "summary and raw are separate reasoning items");
  assert.deepEqual(items[0].content, []);
  assert.match(items[0].summary[0], /Summary/);
  assert.deepEqual(items[1].summary, []);
  assert.match(items[1].content[0], /RAW> /);
  assert.equal(items[0].id !== items[1].id, true);
  c.close();
});

test("mcp-app-interactive: mcpServerStatus/list returns the registered tools (+ visibility); mcpServer/tool/call runs them; resource has the bridge script", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  assert.deepEqual((await c.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" })).result, { data: [], nextCursor: null }, "nothing registered before the scenario ran");
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:mcp-app-interactive] go"));
  await c.note("turn/completed");
  const list = (await c.request("mcpServerStatus/list", { threadId, serverName: "deploys", detail: "toolsAndAuthOnly" })).result;
  assert.equal(list.data.length, 1);
  const srv = list.data[0];
  assert.equal(srv.name, "deploys");
  assert.equal(srv.authStatus, "unsupported");
  assert.deepEqual(srv.resources, []);
  assert.deepEqual(Object.keys(srv.tools).sort(), ["deploy_status", "restart_service", "rotate_keys"]);
  assert.equal(srv.tools.deploy_status.annotations.readOnlyHint, true, "read-only tools run without a confirm dialog");
  assert.equal(srv.tools.deploy_status.annotations.title, "Deploy status");
  assert.equal(srv.tools.restart_service.annotations.readOnlyHint, undefined, "state-changing tool: T3 asks first");
  assert.deepEqual(srv.tools.deploy_status._meta.ui.visibility, ["model", "app"]);
  assert.deepEqual(srv.tools.rotate_keys._meta.ui.visibility, ["model"]);
  assert.equal(srv.tools.deploy_status.inputSchema.type, "object");
  assert.equal((await c.request("mcpServerStatus/list", { threadId, serverName: "other" })).result.data.length, 0);
  const call1 = (await c.request("mcpServer/tool/call", { threadId, server: "deploys", tool: "deploy_status", arguments: { env: "prod" } })).result;
  assert.match(call1.content[0].text, /env=prod, check #1/);
  assert.equal(call1.isError, false);
  const call2 = (await c.request("mcpServer/tool/call", { threadId, server: "deploys", tool: "deploy_status", arguments: {} })).result;
  assert.match(call2.content[0].text, /check #2/, "each call is computed live");
  const uri = c.frames.find((f) => f.method === "item/completed" && f.params.item.type === "mcpToolCall").params.item.mcpAppUi.resourceUri;
  const res = (await c.request("mcpServer/resource/read", { threadId, server: "deploys", uri })).result;
  assert.match(res.contents[0].text, /tools\/call/);
  assert.match(res.contents[0].text, /ui\/initialize/);
  c.close();
});

test("feedback/upload: answers a thread id and records the report (T3 /feedback)", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  const r = (await c.request("feedback/upload", { classification: "bug", includeLogs: true, reason: "composer glitch", threadId })).result;
  assert.match(r.threadId, /^[0-9a-f-]{36}$/);
  const rec = JSON.parse(readFileSync(join(c.ctl, "feedback.jsonl"), "utf8").trim());
  assert.equal(rec.reason, "composer glitch");
  assert.equal(rec.feedbackId, r.threadId);
  c.close();
});

test("account state (reset credits) is shared across processes: a credit redeemed in one app-server shows in the next", async () => {
  const cwd = workspace();
  const env = { MOCK_CODEX_ACCOUNT: "chatgpt", MOCK_CODEX_PLAN: "pro", MOCK_CODEX_RESET_CREDITS: "2" };
  const a = client({ cwd, env });
  await boot(a);
  const before = (await a.request("account/rateLimits/read", null)).result;
  assert.equal(before.rateLimitResetCredits.availableCount, 2);
  assert.equal(before.rateLimits.primary.usedPercent, 23);
  assert.deepEqual((await a.request("account/rateLimitResetCredit/consume", { idempotencyKey: "k" })).result, { outcome: "reset" });
  a.close();
  // T3 re-probes through a fresh app-server process: it must see the redemption
  const b = client({ cwd, env });
  await boot(b);
  const after = (await b.request("account/rateLimits/read", null)).result;
  assert.equal(after.rateLimitResetCredits.availableCount, 1);
  assert.equal(after.rateLimits.primary.usedPercent, 0);
  assert.equal(after.rateLimits.secondary.usedPercent, 0);
  b.close();
});

test("IR: dynTool / asyncAsk / think raw degrade to plain steps on a sink without them", async () => {
  const out = [];
  const sink = {
    message: (t) => out.push(["say", t]),
    thought: (t, o) => out.push(["think", t, o?.raw === true]),
    toolStart: (x) => out.push(["start", x.title]),
    toolUpdate: (x) => out.push(["update", x.status, x.text]),
    plan() {},
    permission: async () => "allow",
    ask: async () => ({ answers: {} }),
  };
  const ctx = { signal: undefined, pace: { chunkWords: 99, chunkMs: () => 0, toolMs: 0 }, cwd: tmpdir(), env: {}, nextToolId: (() => { let n = 0; return () => `t${++n}`; })() };
  await runSteps([S.dynTool({ namespace: "ns", tool: "t", output: "o" }), S.asyncAsk({ text: "Q?", questions: [{ title: "Pick", options: ["a", "b"] }] }), S.think("deep", { raw: true })], sink, ctx);
  assert.deepEqual(out[0], ["start", "ns.t"]);
  assert.deepEqual(out[1], ["update", "completed", "o"]);
  const say = out.find((o) => o[0] === "say")[1];
  assert.match(say, /Q\?/);
  assert.match(say, /- Pick \(a \/ b\)/);
  assert.deepEqual(out.at(-1), ["think", "deep", true]);
});

test("scenario registry has the new scenarios", async () => {
  const all = await loadScenarios();
  for (const id of ["bg-terminal", "bg-wake", "dynamic-tool", "async-ask", "subagent-activity", "raw-reasoning", "mcp-app-interactive"]) assert.ok(all.get(id), id);
});
