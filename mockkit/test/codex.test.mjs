// node --test mockkit/test  (no T3 needed). Drives the Codex app-server mock over stdio like the T3 codex driver does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "../adapters/codex.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/t3-mock-codex.mjs");
const launcher = join(here, "../bin/mock-cli.sh");

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "mk-cx-ws-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/greeting.ts"), "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n");
  writeFileSync(join(cwd, "README.md"), "# hi\n");
  writeFileSync(join(cwd, "package.json"), "{}\n");
  spawnSync("git", ["init", "-q"], { cwd });
  return cwd;
}

function client({ cwd = workspace(), env = {}, args = ["app-server"] } = {}) {
  const p = spawn(process.execPath, [bin, ...args], {
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

async function boot(c, extra = {}) {
  const init = await c.request("initialize", { clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" }, capabilities: { experimentalApi: true }, ...extra });
  c.send({ method: "initialized" });
  return init.result;
}

async function startThread(c) {
  const r = await c.request("thread/start", { cwd: c.cwd, model: "gpt-6-astra" });
  return r.result.thread.id;
}

const turnParams = (threadId, cwd, text, approvalPolicy = "on-request") => ({
  threadId,
  cwd,
  model: "gpt-6-astra",
  approvalPolicy,
  input: [{ type: "text", text, text_elements: [] }],
});

const agentText = (frames) =>
  frames
    .filter((f) => f.method === "item/agentMessage/delta")
    .map((f) => f.params.delta)
    .join("");

test("probe: initialize, account/read, skills/list, model/list, config/read, rateLimits", async () => {
  const c = client();
  const init = await boot(c);
  assert.match(init.userAgent, /\/0\.159\.0 /); // version regex used by T3: /\/([^\s]+)/
  assert.ok(init.codexHome);
  assert.equal(init.platformFamily, "unix");
  const dup = await c.request("initialize", {});
  assert.equal(dup.error.code, -32600);
  assert.equal(dup.error.message, "Already initialized");
  const acc = await c.request("account/read", {});
  assert.deepEqual(acc.result, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
  const skills = await c.request("skills/list", { cwds: [c.cwd] });
  assert.deepEqual(skills.result.data, [{ cwd: c.cwd, skills: [], errors: [] }]);
  const models = await c.request("model/list", {});
  assert.equal(models.result.nextCursor, null);
  const m = models.result.data;
  assert.equal(m.filter((x) => x.isDefault).length, 1);
  for (const x of m) {
    assert.ok(x.model && x.displayName && x.id);
    assert.equal(typeof x.hidden, "boolean");
    assert.ok(x.supportedReasoningEfforts.length > 0);
    assert.ok(x.supportedReasoningEfforts.every((e) => e.reasoningEffort && typeof e.description === "string"));
    assert.ok(x.supportedReasoningEfforts.some((e) => e.reasoningEffort === x.defaultReasoningEffort));
  }
  assert.equal((await c.request("config/read", { includeLayers: false })).result.config.service_tier, undefined);
  assert.equal((await c.request("account/rateLimits/read", null)).result.rateLimits.limitId, "codex");
  c.close();
});

test("probe: unauth mode reports requiresOpenaiAuth; old mode reports an old version", async () => {
  const u = client({ env: { MOCK_CLI_MODE: "unauth" } });
  await boot(u);
  assert.deepEqual((await u.request("account/read", {})).result, { account: null, requiresOpenaiAuth: true });
  u.close();
  const o = client({ env: { MOCK_CLI_MODE: "old" } });
  assert.match((await boot(o)).userAgent, /\/0\.100\.0 /);
  o.close();
});

test("unknown requests get a JSON-RPC error, never a hang", async () => {
  const c = client();
  await boot(c);
  const r = await c.request("thread/madeUp", {});
  assert.equal(r.error.code, -32601);
  assert.deepEqual((await c.request("mcpServerStatus/list", {})).result, { data: [], nextCursor: null });
  c.close();
});

test("echo turn: thread/turn lifecycle, deltas, token usage, turn 2 sees history", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.note("thread/started");
  const r1 = await c.request("turn/start", turnParams(threadId, c.cwd, "Hello, mock agent"));
  assert.equal(r1.result.turn.status, "inProgress");
  const done1 = await c.note("turn/completed");
  assert.equal(done1.params.turn.status, "completed");
  assert.match(agentText(c.frames), /turn 1.*Hello, mock agent/);
  const order = c.frames.filter((f) => f.method).map((f) => f.method);
  assert.ok(order.indexOf("turn/started") < order.indexOf("item/started"));
  assert.ok(order.indexOf("thread/tokenUsage/updated") < order.indexOf("turn/completed"));
  const usage = c.frames.find((f) => f.method === "thread/tokenUsage/updated").params.tokenUsage;
  assert.equal(usage.modelContextWindow, 258400);
  assert.ok(usage.last.inputTokens > 0 && usage.total.totalTokens === usage.total.inputTokens + usage.total.outputTokens);
  const completedMsg = c.frames.find((f) => f.method === "item/completed" && f.params.item.type === "agentMessage");
  assert.equal(completedMsg.params.item.phase, "final_answer");
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "second message"));
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /turn 2.*previous message was: "Hello, mock agent"/);
  c.close();
});

test("thread/resume after a respawn keeps the turn count (state persisted in the control dir)", async () => {
  const cwd = workspace();
  const a = client({ cwd });
  await boot(a);
  const threadId = await startThread(a);
  await a.request("turn/start", turnParams(threadId, cwd, "first"));
  await a.note("turn/completed");
  a.close();
  const b = client({ cwd });
  await boot(b);
  const res = await b.request("thread/resume", { threadId, cwd });
  assert.equal(res.result.thread.id, threadId);
  await b.request("turn/start", turnParams(threadId, cwd, "again"));
  await b.note("turn/completed");
  assert.match(agentText(b.frames), /turn 2.*previous message was: "first"/);
  const read = await b.request("thread/read", { threadId, includeTurns: true });
  assert.equal(read.result.thread.turns.length, 2);
  b.close();
});

test("edit-file-diff: REAL fs writes, fileChange items with unified diff, read + command items", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:edit-file-diff] go", "never"));
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  assert.match(readFileSync(join(c.cwd, "src/greeting.ts"), "utf8"), /Welcome aboard/);
  assert.ok(existsSync(join(c.cwd, "src/farewell.ts")));
  const changes = c.frames.filter((f) => f.method === "item/completed" && f.params.item.type === "fileChange");
  assert.equal(changes.length, 2);
  const upd = changes.find((f) => f.params.item.changes[0].path.endsWith("greeting.ts")).params.item;
  assert.equal(upd.status, "completed");
  assert.deepEqual(upd.changes[0].kind, { type: "update", move_path: null });
  assert.match(upd.changes[0].diff, /^@@ -\d+,\d+ \+\d+,\d+ @@\n/);
  assert.match(upd.changes[0].diff, /\+  return `Hello, \$\{who\}! Welcome aboard\.`;/);
  const add = changes.find((f) => f.params.item.changes[0].path.endsWith("farewell.ts")).params.item;
  assert.deepEqual(add.changes[0].kind, { type: "add" });
  const cmds = c.frames.filter((f) => f.method === "item/completed" && f.params.item.type === "commandExecution").map((f) => f.params.item);
  const read = cmds.find((i) => i.commandActions[0].type === "read");
  assert.match(read.aggregatedOutput, /export function greet/);
  assert.equal(read.commandActions[0].name, "greeting.ts");
  const sh = cmds.find((i) => /git status/.test(i.command));
  assert.equal(sh.exitCode, 0);
  assert.equal(typeof sh.aggregatedOutput, "string");
  c.close();
});

test("approval-allow: supervised turn asks via item/fileChange/requestApproval, accept writes the file", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:approval-allow] write notes"));
  const req = await c.waitFor((f) => f.method === "item/fileChange/requestApproval");
  assert.equal(req.params.threadId, threadId);
  assert.ok(req.params.itemId && req.params.turnId);
  const started = c.frames.find((f) => f.method === "item/started" && f.params.item.id === req.params.itemId);
  assert.equal(started.params.item.type, "fileChange");
  assert.ok(!existsSync(join(c.cwd, "NOTES.md")), "nothing written before the decision");
  c.send({ id: req.id, result: { decision: "accept" } });
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  assert.ok(existsSync(join(c.cwd, "NOTES.md")));
  assert.match(agentText(c.frames), /Approved: `NOTES.md` was written/);
  assert.ok(c.frames.some((f) => f.method === "serverRequest/resolved" && f.params.requestId === req.id));
  c.close();
});

test("approval-allow: acceptForSession also allows; approvalPolicy never skips the request", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:approval-allow] a"));
  const req = await c.waitFor((f) => f.method === "item/fileChange/requestApproval");
  c.send({ id: req.id, result: { decision: "acceptForSession" } });
  await c.note("turn/completed");
  assert.ok(existsSync(join(c.cwd, "NOTES.md")));
  c.close();
  const n = client();
  await boot(n);
  const tid = await startThread(n);
  await n.request("turn/start", turnParams(tid, n.cwd, "[mock:approval-allow] a", "never"));
  await n.note("turn/completed");
  assert.ok(!n.frames.some((f) => /requestApproval$/.test(f.method ?? "")), "full access never asks");
  assert.ok(existsSync(join(n.cwd, "NOTES.md")));
  n.close();
});

test("approval-deny: decline runs onReject, command never executes, item is declined", async () => {
  const c = client();
  await boot(c);
  mkdirSync(join(c.cwd, "build"), { recursive: true });
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:approval-deny] clean"));
  const req = await c.waitFor((f) => f.method === "item/commandExecution/requestApproval");
  assert.equal(req.params.kind, "command");
  assert.ok(req.params.command && req.params.availableDecisions.includes("decline"));
  c.send({ id: req.id, result: { decision: "decline" } });
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  assert.match(agentText(c.frames), /Understood, I will leave/);
  const item = c.frames.find((f) => f.method === "item/completed" && f.params.item.id === req.params.itemId).params.item;
  assert.equal(item.status, "declined");
  assert.ok(existsSync(join(c.cwd, "build")));
  c.close();
});

test("ask: item/tool/requestUserInput, answer flows back into the scenario", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:ask] choose"));
  const req = await c.waitFor((f) => f.method === "item/tool/requestUserInput");
  const q = req.params.questions[0];
  assert.equal(q.id, "style");
  assert.equal(req.params.isBlocking, true);
  assert.equal(q.options[0].label, "Strict (Recommended)");
  c.send({ id: req.id, result: { answers: { style: { answers: ["Strict (Recommended)"] } } } });
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "completed");
  assert.match(agentText(c.frames), /going with: \["Strict \(Recommended\)"\]/);
  c.close();
});

test("interrupt: turn/interrupt replies {} and the held turn completes as interrupted", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  const started = await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:slow hold=t1] run"));
  const turnId = started.result.turn.id;
  await c.waitFor((f) => f.method === "item/agentMessage/delta");
  const r = await c.request("turn/interrupt", { threadId, turnId });
  assert.deepEqual(r.result, {});
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "interrupted");
  assert.ok(!/Finished the long task/.test(agentText(c.frames)));
  c.close();
});

test("error-turn: error notification then failed turn; usage-limit maps to usageLimitExceeded + rate limits", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:error-turn] x"));
  const done = await c.note("turn/completed");
  assert.equal(done.params.turn.status, "failed");
  assert.match(done.params.turn.error.message, /mock failure injected/);
  const err = c.frames.find((f) => f.method === "error");
  assert.equal(err.params.willRetry, false);
  assert.equal(err.params.error.codexErrorInfo, "badRequest");
  c.frames.length = 0;
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:usage-limit] x"));
  const d2 = await c.note("turn/completed");
  assert.equal(d2.params.turn.status, "failed");
  assert.equal(d2.params.turn.error.codexErrorInfo, "usageLimitExceeded");
  const rl = c.frames.find((f) => f.method === "account/rateLimits/updated").params.rateLimits;
  assert.equal(rl.primary.usedPercent, 100);
  assert.equal(rl.limitId, "codex");
  c.close();
});

test("plan scenario emits turn/plan/updated; tool-read emits a read command; todo statuses map to Codex", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:plan] x"));
  await c.note("turn/completed");
  const plans = c.frames.filter((f) => f.method === "turn/plan/updated");
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].params.plan.map((p) => p.status), ["inProgress", "pending", "pending"]);
  assert.deepEqual(plans[1].params.plan.map((p) => p.status), ["completed", "inProgress", "pending"]);
  c.close();
});

test("queued (hidden) routing picks the scenario without any tag in the prompt", async () => {
  const cwd = workspace();
  const ctl = join(cwd, ".ctl");
  const { enqueue } = await import("../lib/queue.mjs");
  enqueue("markdown-stream", {}, { cwd, env: { MOCK_CONTROL_DIR: ctl } });
  const c = client({ cwd });
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, cwd, "Show me a markdown demo."));
  await c.note("turn/completed");
  assert.match(agentText(c.frames), /Streaming markdown demo/);
  assert.ok(!/\[mock:/.test(JSON.stringify(c.frames)));
  c.close();
});

test("thread/compact/start runs a contextCompaction turn; thread/fork returns a new thread", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "hello"));
  await c.note("turn/completed");
  c.frames.length = 0;
  assert.deepEqual((await c.request("thread/compact/start", { threadId })).result, {});
  await c.note("turn/completed");
  assert.ok(c.frames.some((f) => f.method === "item/completed" && f.params.item.type === "contextCompaction"));
  const fork = await c.request("thread/fork", { threadId });
  assert.notEqual(fork.result.thread.id, threadId);
  assert.equal(fork.result.thread.forkedFromId, threadId);
  c.close();
});

test("exec text generation: schema-driven JSON written to --output-last-message (title uses the scenario title)", async () => {
  const cwd = workspace();
  const schema = join(cwd, "schema.json");
  const out = join(cwd, "out.json");
  writeFileSync(schema, JSON.stringify({ type: "object", properties: { title: { type: "string" } }, required: ["title"] }));
  const r = spawnSync(process.execPath, [bin, "exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--model", "gpt-6-luna", "--output-schema", schema, "--output-last-message", out, "-"], {
    input: "Generate a thread title.\nReturn a JSON object with key: title.\nUser message:\n[mock:error-turn] Run the task.\n",
    env: { ...process.env, MOCK_CONTROL_DIR: join(cwd, ".ctl") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), { title: "Failing turn" });
  const schema2 = join(cwd, "schema2.json");
  writeFileSync(schema2, JSON.stringify({ type: "object", properties: { subject: { type: "string" }, body: { type: "string" }, extra: { type: "string" } } }));
  const r2 = spawnSync(process.execPath, [bin, "exec", "--output-schema", schema2, "--output-last-message", out, "-"], { input: "commit message", env: process.env, encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  const j = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(j.subject && j.body && j.extra);
});

test("CLI surface: --version, mcp list --json (config flags first), launcher routes codex flavor", () => {
  const v = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
  assert.match(v.stdout, /^codex-cli 0\.159\.0/);
  const m = spawnSync(process.execPath, [bin, "--config", "features.plugins=false", "mcp", "list", "--json"], { encoding: "utf8" });
  assert.equal(m.stdout.trim(), "[]");
  const l = spawnSync("sh", [launcher, "--version"], { encoding: "utf8", env: { ...process.env, MOCK_CLI_FLAVOR: "codex" } });
  assert.match(l.stdout, /^codex-cli/);
  const g = spawnSync("sh", [launcher, "--version"], { encoding: "utf8", env: { ...process.env } });
  assert.match(g.stdout, /^grok 1\.0\.13/);
  const bad = spawnSync("sh", [launcher, "app-server"], { encoding: "utf8", input: '{"id":1,"method":"initialize","params":{}}\n', env: { ...process.env, MOCK_CLI_MODE: "broken" } });
  assert.equal(bad.status, 1);
});

test("tokens=<n> queue/tag arg forces the turn's input tokens (context-window meter)", async () => {
  const c = client();
  await boot(c);
  const threadId = await startThread(c);
  await c.request("turn/start", turnParams(threadId, c.cwd, "[mock:echo tokens=190000] big"));
  await c.note("turn/completed");
  const u = c.frames.find((f) => f.method === "thread/tokenUsage/updated").params.tokenUsage;
  assert.equal(u.last.inputTokens, 190000);
  assert.equal(u.modelContextWindow, 258400);
  c.close();
});

test("unifiedDiff: single hunk with context", () => {
  const d = unifiedDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nb\nc\nX\ne\nf\ng\n");
  assert.equal(d, "@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+X\n e\n f\n g\n");
});
