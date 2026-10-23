// node --test mockkit/test  Codex gap closers: MCP elicitation, permission grants, subagents, goals, revert/rollback,
// web search, retry, commentary phase, legacy approvals, chatgpt account + reset credits. Same stdio harness as codex.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { S, runSteps } from "../lib/ir.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/t3-mock-codex.mjs");

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "mk-cx2-ws-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/greeting.ts"), "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(cwd, "package.json"), '{"scripts":{"build":"tsc"}}\n');
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

function client({ cwd = workspace(), env = {} } = {}) {
  const p = spawn(process.execPath, [bin, "app-server"], {
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
      frames.push(JSON.parse(line));
      waiters.slice().forEach((w) => w());
    }
  });
  let id = 0;
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
  const request = (method, params) => {
    const my = ++id;
    send({ id: my, method, params });
    return waitFor((f) => f.id === my && f.method === undefined);
  };
  const note = (method, pred = () => true) => waitFor((f) => f.method === method && f.id === undefined && pred(f.params));
  return { p, frames, send, request, waitFor, note, cwd, close: () => p.stdin.end() };
}

async function boot(c) {
  await c.request("initialize", { clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" }, capabilities: { experimentalApi: true } });
  c.send({ method: "initialized" });
}
const startThread = async (c) => (await c.request("thread/start", { cwd: c.cwd, model: "gpt-6-astra" })).result.thread.id;
const turnParams = (threadId, cwd, text, approvalPolicy = "on-request") => ({ threadId, cwd, model: "gpt-6-astra", approvalPolicy, input: [{ type: "text", text, text_elements: [] }] });
const agentText = (frames, threadId) =>
  frames
    .filter((f) => f.method === "item/agentMessage/delta" && (!threadId || f.params.threadId === threadId))
    .map((f) => f.params.delta)
    .join("");

test("mcp-elicit: mcpServer/elicitation/request (form, app_name + persist meta); accept runs the MCP tool", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:mcp-elicit] go"));
  const req = await c.waitFor((f) => f.method === "mcpServer/elicitation/request");
  assert.equal(req.params.serverName, "linear");
  assert.equal(req.params.mode, "form");
  assert.equal(req.params.threadId, threadId);
  assert.ok(req.params.turnId, "turn id lets T3 find the active turn");
  assert.equal(req.params._meta.app_name, "Linear");
  assert.deepEqual(req.params._meta.persist, ["session", "always"]);
  assert.deepEqual(req.params.requestedSchema, { type: "object", properties: {} });
  assert.ok(!c.frames.some((f) => f.method === "item/started" && f.params.item.type === "mcpToolCall"), "tool not run before the decision");
  c.send({ id: req.id, result: { action: "accept", _meta: { persist: "session" }, content: {} } });
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  const tool = c.frames.find((f) => f.method === "item/completed" && f.params.item.type === "mcpToolCall").params.item;
  assert.equal(tool.server, "linear");
  assert.equal(tool.tool, "search_issues");
  assert.match(agentText(c.frames), /Found 2 open bugs/);
  assert.ok(c.frames.some((f) => f.method === "serverRequest/resolved" && f.params.requestId === req.id));
  c.close();
});

test("mcp-elicit: decline / cancel / approvalPolicy never", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:mcp-elicit] go"));
  const req = await c.waitFor((f) => f.method === "mcpServer/elicitation/request");
  c.send({ id: req.id, result: { action: "decline" } });
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /I will not query Linear/);
  assert.ok(!c.frames.some((f) => f.method === "item/started" && f.params.item.type === "mcpToolCall"));
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:mcp-elicit] again"));
  const req2 = await c.waitFor((f) => f.method === "mcpServer/elicitation/request");
  c.send({ id: req2.id, result: { action: "cancel" } });
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "interrupted");
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:mcp-elicit] full access", "never"));
  const never = await c.note("turn/completed");
  assert.equal(never.params.turn.status, "completed");
  assert.ok(!c.frames.some((f) => f.method === "mcpServer/elicitation/request"));
  c.close();
});

test("perm-grant: item/permissions/requestApproval carries the permission profile; granted -> runs, empty grant -> onReject", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:perm-grant] go"));
  const req = await c.waitFor((f) => f.method === "item/permissions/requestApproval");
  assert.equal(req.params.reason, "Write build output to dist/");
  assert.deepEqual(req.params.permissions.fileSystem.write, [join(c.cwd, "dist")]);
  assert.equal(req.params.cwd, c.cwd);
  assert.ok(req.params.itemId && req.params.turnId && req.params.startedAtMs);
  assert.ok(!existsSync(join(c.cwd, "dist/build.log")));
  c.send({ id: req.id, result: { permissions: req.params.permissions, scope: "turn" } });
  await c.note("turn/completed");
  assert.ok(existsSync(join(c.cwd, "dist/build.log")));
  assert.match(agentText(c.frames), /Granted: wrote/);
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:perm-grant] again"));
  const req2 = await c.waitFor((f) => f.method === "item/permissions/requestApproval");
  c.send({ id: req2.id, result: { permissions: {}, scope: "turn" } });
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /skipping the build output/);
  c.close();
});

test("subagent-spawn: spawnAgent registers a child thread, the child turn runs on its own ids, wait item reports the result", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:subagent-spawn] go", "never"));
  const done = await c.note("turn/completed", (p) => p.threadId === threadId);
  assert.equal(done.params.turn.status, "completed");
  const spawns = c.frames.filter((f) => f.method === "item/completed" && f.params.item.type === "collabAgentToolCall" && f.params.item.tool === "spawnAgent");
  assert.equal(spawns.length, 2);
  const s1 = spawns[0].params.item;
  assert.equal(s1.senderThreadId, threadId);
  assert.equal(s1.receiverThreadIds.length, 1);
  assert.match(s1.prompt, /greet\(\)/);
  const childId = s1.receiverThreadIds[0];
  assert.notEqual(childId, threadId);
  assert.deepEqual(s1.agentsStates[childId], { status: "running", message: null });
  // child turn: own thread id + own turn id, started before it completed, items carry the child ids
  const cStart = c.frames.findIndex((f) => f.method === "turn/started" && f.params.threadId === childId);
  const cDone = c.frames.findIndex((f) => f.method === "turn/completed" && f.params.threadId === childId);
  assert.ok(cStart > c.frames.indexOf(spawns[0]) && cDone > cStart);
  const childTurnId = c.frames[cStart].params.turn.id;
  assert.notEqual(childTurnId, done.params.turn.id);
  assert.ok(c.frames.some((f) => f.method === "item/started" && f.params.threadId === childId && f.params.turnId === childTurnId && f.params.item.type === "commandExecution" && f.params.item.commandActions[0].type === "read"));
  assert.match(agentText(c.frames, childId), /not called anywhere else/);
  assert.equal(agentText(c.frames, threadId).includes("not called anywhere else"), false, "child text does not leak into the parent thread");
  // wait item: completed, carries the child's final message
  const wait = c.frames.find((f) => f.method === "item/completed" && f.params.item.type === "collabAgentToolCall" && f.params.item.tool === "wait" && f.params.item.receiverThreadIds[0] === childId).params.item;
  assert.equal(wait.agentsStates[childId].status, "completed");
  assert.match(wait.agentsStates[childId].message, /not called anywhere else/);
  // child thread is readable and linked to the parent
  const read = await c.request("thread/read", { threadId: childId, includeTurns: false });
  assert.equal(read.result.thread.parentThreadId, threadId);
  assert.equal(read.result.thread.agentNickname, "explorer");
  c.close();
});

test("goal: thread/goal/set|get|clear, thread/goal/updated carries usage, IR goal step completes it", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  assert.deepEqual((await c.request("thread/goal/get", { threadId })).result, { goal: null });
  const noGoal = await c.request("thread/goal/set", { threadId, status: "paused" });
  assert.equal(noGoal.error.code, -32602);
  const set = await c.request("thread/goal/set", { threadId, objective: "Ship the greeting helper", status: "paused" });
  assert.equal(set.result.goal.status, "paused");
  assert.equal(set.result.goal.objective, "Ship the greeting helper");
  assert.equal(set.result.goal.threadId, threadId);
  assert.equal((await c.note("thread/goal/updated")).params.goal.status, "paused");
  const act = await c.request("thread/goal/set", { threadId, status: "active" });
  assert.equal(act.result.goal.status, "active");
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:goal-work] Ship the greeting helper", "never"));
  await c.note("turn/completed");
  const updates = c.frames.filter((f) => f.method === "thread/goal/updated").map((f) => f.params.goal);
  assert.equal(updates.at(-1).status, "complete");
  assert.equal(updates.at(-1).tokensUsed, 4200);
  const got = await c.request("thread/goal/get", { threadId });
  assert.equal(got.result.goal.status, "complete");
  const cleared = await c.request("thread/goal/clear", { threadId });
  assert.deepEqual(cleared.result, { cleared: true });
  assert.equal((await c.note("thread/goal/cleared")).params.threadId, threadId);
  assert.deepEqual((await c.request("thread/goal/clear", { threadId })).result, { cleared: false });
  c.close();
});

test("goal: an active goal accrues token usage after each turn", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("thread/goal/set", { threadId, objective: "Keep going", status: "active" });
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:echo] x", "never"));
  await c.note("turn/completed");
  const last = c.frames.filter((f) => f.method === "thread/goal/updated").at(-1).params.goal;
  assert.equal(last.status, "active");
  assert.ok(last.tokensUsed > 0 && last.timeUsedSeconds >= 1);
  c.close();
});

async function threeTurns(c) {
  const threadId = await startThread(c);
  for (const text of ["one", "two", "three"]) {
    await c.request("turn/start", turnParams(threadId, c.cwd, `[mock:echo] ${text}`, "never"));
    await c.waitFor((f) => f.method === "turn/completed" && agentText(c.frames).includes(`turn ${["one", "two", "three"].indexOf(text) + 1}`));
  }
  return threadId;
}

test("thread/turns/list pages newest-first with cursor; thread/revert drops beforeTurnId and later turns", async () => {
  const c = client();
  await boot(c);
  const threadId = await threeTurns(c);
  const asc = await c.request("thread/turns/list", { threadId });
  assert.equal(asc.result.data.length, 3);
  const page1 = await c.request("thread/turns/list", { threadId, limit: 2, sortDirection: "desc", itemsView: "summary" });
  assert.deepEqual(page1.result.data.map((t) => t.id), [asc.result.data[2].id, asc.result.data[1].id]);
  assert.equal(page1.result.nextCursor, "2");
  const page2 = await c.request("thread/turns/list", { threadId, limit: 2, sortDirection: "desc", cursor: page1.result.nextCursor });
  assert.deepEqual(page2.result.data.map((t) => t.id), [asc.result.data[0].id]);
  assert.equal(page2.result.nextCursor, null);
  const rev = await c.request("thread/revert", { threadId, beforeTurnId: asc.result.data[1].id });
  assert.equal(rev.result.thread.id, threadId);
  assert.equal(rev.result.thread.turns.length, 1);
  assert.equal((await c.request("thread/turns/list", { threadId })).result.data.length, 1);
  // next turn continues from the reverted history: turn 2 again, previous message is "one"
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:echo] redo", "never"));
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /turn 2.*previous message was: "one"/);
  const bad = await c.request("thread/revert", { threadId, beforeTurnId: "nope" });
  assert.equal(bad.error.code, -32602);
  c.close();
});

test("thread/rollback drops the last numTurns; reverted state survives a respawn", async () => {
  const cwd = workspace();
  const a = client({ cwd });
  await boot(a);
  const threadId = await threeTurns(a);
  const rb = await a.request("thread/rollback", { threadId, numTurns: 2 });
  assert.equal(rb.result.thread.turns.length, 1);
  a.close();
  const b = client({ cwd });
  await boot(b);
  await b.request("thread/resume", { threadId, cwd });
  assert.equal((await b.request("thread/read", { threadId, includeTurns: true })).result.thread.turns.length, 1);
  b.close();
});

test("web-search + commentary: webSearch item (search then openPage), agentMessage phase commentary vs final_answer", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:web-search] go", "never"));
  await c.note("turn/completed");
  const searches = c.frames.filter((f) => f.method === "item/completed" && f.params.item.type === "webSearch").map((f) => f.params.item);
  assert.equal(searches.length, 2);
  assert.deepEqual(searches[0].action, { type: "search", query: "vite 8 config options", queries: null });
  assert.deepEqual(searches[1].action, { type: "openPage", url: "https://vite.dev/config/" });
  assert.ok(c.frames.some((f) => f.method === "item/started" && f.params.item.type === "webSearch"));
  const phases = c.frames.filter((f) => f.method === "item/completed" && f.params.item.type === "agentMessage").map((f) => f.params.item.phase);
  assert.deepEqual(phases, ["commentary", "final_answer"]);
  c.close();
});

test("provider-retry: error notification with willRetry true and N/M progress text, then the turn completes", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:provider-retry] go", "never"));
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  const errs = c.frames.filter((f) => f.method === "error");
  assert.equal(errs.length, 2);
  assert.equal(errs[0].params.willRetry, true);
  assert.match(errs[1].params.error.message, /2\/5/);
  assert.deepEqual(errs[0].params.error.codexErrorInfo, { responseStreamDisconnected: { httpStatusCode: null } });
  assert.equal(done.params.turn.error, null);
  c.close();
});

test("legacy approvals (MOCK_CODEX_LEGACY_APPROVALS=1): execCommandApproval / applyPatchApproval keyed by conversationId", async () => {
  const c = client({ env: { MOCK_CODEX_LEGACY_APPROVALS: "1" } });
  await boot(c);
  mkdirSync(join(c.cwd, "build"), { recursive: true });
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:approval-deny] clean"));
  const exec = await c.waitFor((f) => f.method === "execCommandApproval");
  assert.equal(exec.params.conversationId, threadId);
  assert.ok(exec.params.callId && Array.isArray(exec.params.command));
  c.send({ id: exec.id, result: { decision: "denied" } });
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /Understood, I will leave/);
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:approval-allow] write notes"));
  const patch = await c.waitFor((f) => f.method === "applyPatchApproval");
  assert.equal(patch.params.conversationId, threadId);
  assert.ok(Object.keys(patch.params.fileChanges)[0].endsWith("NOTES.md"));
  c.send({ id: patch.id, result: { decision: "approved" } });
  await c.note("turn/completed");
  assert.ok(existsSync(join(c.cwd, "NOTES.md")));
  c.close();
});

test("chatgpt account: plan, models_cache.json, account id + reset credits in rateLimits, credit consume", async () => {
  const c = client({ env: { MOCK_CODEX_ACCOUNT: "chatgpt", MOCK_CODEX_PLAN: "pro", MOCK_CODEX_RESET_CREDITS: "1" } });
  const init = await c.request("initialize", { clientInfo: { name: "T3 Code" }, capabilities: { experimentalApi: true } });
  c.send({ method: "initialized" });
  const acc = await c.request("account/read", {});
  assert.deepEqual(acc.result, { account: { type: "chatgpt", email: "mock@example.com", planType: "pro" }, requiresOpenaiAuth: false });
  const cache = JSON.parse(readFileSync(join(init.result.codexHome, "models_cache.json"), "utf8"));
  assert.ok(Date.parse(cache.fetched_at) > Date.now() - 60_000);
  const rl = (await c.request("account/rateLimits/read", null)).result;
  assert.equal(rl.accountId, "acct_mockkit_0001");
  assert.equal(rl.rateLimits.planType, "pro");
  assert.equal(rl.rateLimitResetCredits.availableCount, 1);
  assert.equal(rl.rateLimitResetCredits.credits[0].status, "available");
  assert.deepEqual((await c.request("account/rateLimitResetCredit/consume", { idempotencyKey: "k" })).result, { outcome: "reset" });
  assert.deepEqual((await c.request("account/rateLimitResetCredit/consume", { idempotencyKey: "k2" })).result, { outcome: "noCredit" });
  assert.equal((await c.request("account/rateLimits/read", null)).result.rateLimitResetCredits.availableCount, 0);
  c.close();
  // api-key account keeps the lean shape
  const k = client();
  await boot(k);
  assert.equal((await k.request("account/rateLimits/read", null)).result.accountId, undefined);
  k.close();
});

test("mcp-app: mcpToolCall carries mcpAppUi.resourceUri; mcpServer/resource/read serves the HTML with the mcp-app mime type", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:mcp-app] go", "never"));
  await c.note("turn/completed");
  const done = c.frames.find((f) => f.method === "item/completed" && f.params.item.type === "mcpToolCall").params.item;
  assert.equal(done.status, "completed");
  assert.equal(done.server, "linear");
  assert.equal(done.tool, "issue_board");
  assert.equal(done.mcpAppUi.resourceUri, "ui://linear/issue_board.html");
  assert.equal(done.mcpAppUi.preferredModelDisplayMode, "inline");
  assert.deepEqual(done.result.content, [{ type: "text", text: "3 issues (2 open)" }]);
  const res = await c.request("mcpServer/resource/read", { threadId, server: "linear", uri: done.mcpAppUi.resourceUri });
  assert.equal(res.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(res.result.contents[0].text, /MOCK-12/);
  assert.equal((await c.request("mcpServer/resource/read", { threadId, server: "linear", uri: "ui://nope" })).error.code, -32602);
  assert.equal((await c.request("mcpServer/tool/call", { threadId, server: "linear", tool: "x", arguments: {} })).result.isError, false);
  c.close();
});

test("subagent-approval: the child's approval request carries the child thread + turn ids", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:subagent-approval] go"));
  const req = await c.waitFor((f) => f.method === "item/fileChange/requestApproval");
  assert.notEqual(req.params.threadId, threadId, "request belongs to the child thread");
  const childStarted = c.frames.find((f) => f.method === "turn/started" && f.params.threadId === req.params.threadId);
  assert.equal(childStarted.params.turn.id, req.params.turnId);
  assert.ok(!existsSync(join(c.cwd, "NOTES.md")));
  c.send({ id: req.id, result: { decision: "accept" } });
  const done = await c.note("turn/completed", (p) => p.threadId === threadId);
  assert.equal(done.params.turn.status, "completed");
  assert.ok(existsSync(join(c.cwd, "NOTES.md")));
  assert.match(agentText(c.frames, threadId), /writer subagent finished/);
  c.close();
});

// ---- provider-neutral IR: ACP-style sinks without the Codex ops degrade ---------------------------------
const quietCtx = () => ({ cwd: tmpdir(), env: {}, signal: undefined, pace: { chunkWords: 5, chunkMs: () => 0, toolMs: 0 }, log: () => {}, answers: {}, nextToolId: (() => { let n = 0; return () => `t${++n}`; })() });
function recordingSink(decision = "allow") {
  const ev = [];
  return {
    ev,
    message: (t) => ev.push(["message", t]),
    thought() {},
    toolStart: (x) => ev.push(["toolStart", x.kind, x.title]),
    toolUpdate: (x) => ev.push(["toolUpdate", x.status, x.text]),
    plan() {},
    permission: async (p) => (ev.push(["permission", p.title]), decision),
    ask: async () => ({ answers: {} }),
    exitPlan: async () => ({}),
  };
}

test("IR degrade (no native sink ops): elicit/grant -> permission, subagent -> one tool call, goal/retry no-op, web -> fetch tool", async () => {
  const sink = recordingSink("allow");
  await runSteps(
    [
      S.elicit({ server: "linear", message: "Allow Linear?", onAccept: [S.say("accepted")] }),
      S.grant({ reason: "Write dist/", write: ["dist"], onAllow: [S.say("granted")] }),
      S.subagent({ name: "w", prompt: "do it", steps: [S.say("child says hi"), S.tool({ kind: "other", title: "hidden" })] }),
      S.goal({ status: "complete" }),
      S.retry("Reconnecting... 1/5"),
      S.web("q", { url: "https://x.test" }),
    ],
    sink,
    quietCtx(),
  );
  const flat = JSON.stringify(sink.ev);
  assert.match(flat, /"permission","Allow Linear\?"/);
  assert.match(flat, /"permission","Write dist\/"/);
  assert.match(flat, /accepted/);
  assert.match(flat, /granted/);
  assert.match(flat, /Subagent w: do it/);
  assert.match(flat, /child says hi/); // output of the degraded tool call
  assert.doesNotMatch(flat, /hidden/);
  assert.match(flat, /"toolStart","fetch","Search the web: q"/);
  // declined path runs onDecline / onReject
  const no = recordingSink("reject");
  await runSteps([S.elicit({ message: "m", onAccept: [S.say("A")], onDecline: [S.say("D")] }), S.grant({ reason: "r", onAllow: [S.say("A2")], onReject: [S.say("R2")] })], no, quietCtx());
  const nf = JSON.stringify(no.ev);
  assert.match(nf, /"message","D"/);
  assert.match(nf, /"message","R2"/);
  assert.doesNotMatch(nf, /"message","A"/);
});

test("ACP adapter: Codex-flavored scenarios still run end to end (degraded)", async () => {
  const acp = join(here, "../bin/t3-mock-acp.mjs");
  const cwd = workspace();
  const p = spawn(process.execPath, [acp], { env: { ...process.env, MOCK_PACE: "fast", MOCK_CONTROL_DIR: join(cwd, ".ctl") }, stdio: ["pipe", "pipe", "inherit"] });
  const frames = [];
  let buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) frames.push(JSON.parse(line));
    }
  });
  const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
  const until = async (pred) => {
    for (let i = 0; i < 400; i++) {
      const f = frames.find(pred);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timeout");
  };
  send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "t" } } });
  await until((f) => f.id === 1);
  send({ id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
  const sessionId = (await until((f) => f.id === 2)).result.sessionId;
  send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "[mock:subagent-spawn] go" }] } });
  assert.equal((await until((f) => f.id === 3)).result.stopReason, "end_turn");
  assert.ok(frames.some((f) => f.params?.update?.title?.startsWith?.("Subagent explorer")));
  send({ id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "[mock:goal-work] go" }] } });
  assert.equal((await until((f) => f.id === 4)).result.stopReason, "end_turn");
  send({ id: 5, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "[mock:mcp-elicit] go" }] } });
  const perm = await until((f) => f.method === "session/request_permission");
  send({ id: perm.id, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
  assert.equal((await until((f) => f.id === 5)).result.stopReason, "end_turn");
  p.stdin.end();
});
