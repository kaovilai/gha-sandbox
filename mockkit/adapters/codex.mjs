// Zero-dep Codex `app-server` (newline-delimited JSON-RPC over stdio) that plays provider-neutral scenarios.
// Targets the T3 Code `codex` driver. Frame shapes copied from upstream
//   apps/server/src/orchestration-v2/testkit/fixtures/*/codex_transcript.ndjson and
//   packages/effect-codex-app-server/src/_generated/schema.gen.ts (read-only recon, t3code @ 807319c).
// Also exports `execText()` for the `codex exec ... --output-last-message F` text-generation path.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ScenarioError, runSteps } from "../lib/ir.mjs";
import { controlDir } from "../lib/hold.mjs";
import { makeLog } from "../lib/log.mjs";
import { abortError, makePace, sleep } from "../lib/pace.mjs";
import { dequeue } from "../lib/queue.mjs";
import { parseTag, promptText, userRequest } from "../lib/select.mjs";
import { textGenJson } from "../lib/textgen.mjs";
import { loadScenarios } from "../scenarios/index.mjs";

export const CODEX_VERSION = "0.159.0"; // >= recommended version: no compatibility banner
const CONTEXT_WINDOW = 258400;

// model/list entries. First entry is the default. (display names pass through formatCodexModelName in T3)
export const CODEX_MODELS = [
  { model: "gpt-6-astra", displayName: "gpt-6-astra", description: "Mock Codex model (mockkit, keyless)", isDefault: true },
  { model: "gpt-6-luna", displayName: "gpt-6-luna", description: "Mock Codex model, fast (mockkit, keyless)", isDefault: false },
  { model: "gpt-5.6-sol", displayName: "gpt-5.6-sol", description: "Mock Codex model, previous generation (mockkit, keyless)", isDefault: false },
];

const nowSec = () => Math.floor(Date.now() / 1000);
const esc = (s) => JSON.stringify(s);

// Single-hunk unified diff (common prefix/suffix, 3 lines of context). Enough for T3's file-change rows.
export function unifiedDiff(oldText, newText) {
  const split = (t) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(oldText);
  const b = split(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ctx = 3;
  const start = Math.max(0, p - ctx);
  const aEnd = a.length - s;
  const bEnd = b.length - s;
  const tail = Math.min(ctx, s);
  const lines = [
    ...a.slice(start, p).map((l) => ` ${l}`),
    ...a.slice(p, aEnd).map((l) => `-${l}`),
    ...b.slice(p, bEnd).map((l) => `+${l}`),
    ...a.slice(aEnd, aEnd + tail).map((l) => ` ${l}`),
  ];
  return `@@ -${start + 1},${aEnd + tail - start} +${start + 1},${bEnd + tail - start} @@\n${lines.join("\n")}\n`;
}

const modelEntry = (m) => ({
  id: m.model,
  model: m.model,
  displayName: m.displayName,
  description: m.description,
  hidden: false,
  isDefault: m.isDefault,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
    { reasoningEffort: "medium", description: "Balances speed and reasoning depth" },
    { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" },
  ],
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  additionalSpeedTiers: [],
  serviceTiers: [],
});

const threadObject = (t) => ({
  id: t.id,
  environments: [{ environmentId: "local", cwd: t.cwd, runtimeWorkspaceRoots: [t.cwd] }],
  extra: null,
  sessionId: t.id,
  forkedFromId: t.forkedFromId ?? null,
  parentThreadId: t.parentThreadId ?? null,
  preview: t.history[0] ?? "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  model: t.model,
  reasoningEffort: null,
  createdAt: t.createdAt,
  updatedAt: nowSec(),
  recencyAt: t.createdAt,
  status: { type: "idle" },
  path: join(t.cwd, `.mock-codex-${t.id}.jsonl`),
  cwd: t.cwd,
  cliVersion: CODEX_VERSION,
  originator: "t3code_desktop",
  source: "vscode",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: t.agentNickname ?? null,
  agentRole: t.agentRole ?? null,
  gitInfo: null,
  name: null,
  daybreakEnabled: null,
  turns: [],
});

const threadResult = (t) => ({
  thread: threadObject(t),
  model: t.model,
  modelProvider: "openai",
  serviceTier: null,
  disabledPluginIds: [],
  cwd: t.cwd,
  runtimeWorkspaceRoots: [t.cwd],
  instructionSources: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  activePermissionProfile: { id: ":workspace", extends: null },
  reasoningEffort: null,
  multiAgentMode: "explicitRequestOnly",
});

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function serveCodex({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const log = makeLog(env.MOCK_LOG, { agent: "codex" });
  const pace = makePace(env);
  const mode = env.MOCK_CLI_MODE || "ready";
  const threads = new Map();
  const pendingOut = new Map();
  let initialized = false;
  let nextOutId = 0;
  let nextTool = 0;
  let nextItem = 0;
  let nextProc = 4000;
  const mcpResources = new Map(); // ui:// uri -> html, served by mcpServer/resource/read
  const ctlDir = controlDir({ ...process.env, ...env });
  const stateDir = join(ctlDir, "codex-threads");
  // Account state (reset credits) must outlive this process: T3 redeems a credit on a SEPARATE short-lived app-server, then re-probes
  // account/rateLimits/read on yet another one, so the snapshot only refreshes if every process reads the same file.
  const accountFile = join(ctlDir, "codex-account.json");
  const accountState = () => ({ available: Number(env.MOCK_CODEX_RESET_CREDITS ?? 2), used: false, ...(readJson(accountFile) ?? {}) });
  const saveAccountState = (st) => {
    try {
      mkdirSync(ctlDir, { recursive: true });
      writeFileSync(accountFile, JSON.stringify(st));
    } catch {}
  };
  const bgProcs = new Map(); // processId -> background terminal (commandExecution item that outlives its turn)
  const mcpServers = new Map(); // server -> Map(tool name -> { name, description, inputSchema, visibility, result }), served by mcpServerStatus/list

  const write = (obj) => {
    log("out", { frame: obj });
    output.write(`${JSON.stringify(obj)}\n`);
  };
  const notify = (method, params) => write({ method, params });
  const reply = (id, result) => write({ id, result });
  const fail = (id, code, message) => write({ id, error: { code, message } });
  const callClient = (method, params, signal) =>
    new Promise((resolveP, reject) => {
      const id = nextOutId++;
      pendingOut.set(id, { resolve: resolveP, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (pendingOut.delete(id)) reject(abortError());
        },
        { once: true },
      );
      write({ id, method, params });
    });

  // ---- thread state (persisted so thread/resume after a respawn keeps turn count + history) --------
  const persist = (t) => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${t.id}.json`), JSON.stringify({ id: t.id, cwd: t.cwd, model: t.model, turn: t.turn, history: t.history, createdAt: t.createdAt, tokens: t.tokens, turns: t.turns, goal: t.goal, parentThreadId: t.parentThreadId, agentNickname: t.agentNickname, agentRole: t.agentRole }));
    } catch {}
  };
  function newThread({ id = randomUUID(), cwd, model, restore = true }) {
    const saved = restore ? readJson(join(stateDir, `${id}.json`)) : null;
    const dir = (saved?.cwd ?? cwd) && existsSync(saved?.cwd ?? cwd) && statSync(saved?.cwd ?? cwd).isDirectory() ? (saved?.cwd ?? cwd) : process.cwd();
    const t = {
      id,
      cwd: dir,
      model: model || saved?.model || CODEX_MODELS[0].model,
      turn: saved?.turn ?? 0,
      history: saved?.history ?? [],
      createdAt: saved?.createdAt ?? nowSec(),
      tokens: saved?.tokens ?? { input: 0, output: 0, cached: 0 },
      turns: saved?.turns ?? [],
      goal: saved?.goal ?? null,
      parentThreadId: saved?.parentThreadId ?? null,
      agentNickname: saved?.agentNickname ?? null,
      agentRole: saved?.agentRole ?? null,
      abort: null,
      activeTurnId: null,
      approvalPolicy: "on-request",
    };
    threads.set(id, t);
    persist(t);
    return t;
  }

  // ---- thread goal (`/goal <objective>` in T3 -> thread/goal/set; IR step `goal` updates it) --------
  const emitGoal = (t, turnId = null) => {
    if (!t.goal) return;
    t.goal.updatedAt = nowSec();
    notify("thread/goal/updated", { threadId: t.id, turnId, goal: { ...t.goal } });
    persist(t);
  };

  // ---- IR sink -> Codex items ------------------------------------------------------------------
  function makeTurnRuntime(t, turnId, signal) {
    const items = []; // completed items (turn/completed summary)
    const tools = new Map();
    // server -> client request; always resolved with serverRequest/resolved (T3 clears the pending card on it)
    const clientRequest = async (method, params) => {
      const reqId = nextOutId;
      try {
        return await callClient(method, params, signal);
      } finally {
        notify("serverRequest/resolved", { threadId: t.id, requestId: reqId });
      }
    };
    let open = null; // open agentMessage | reasoning item
    let outChars = 0;
    const emitStart = (item) => notify("item/started", { item, threadId: t.id, turnId, startedAtMs: Date.now() });
    const emitDone = (item) => {
      items.push(item);
      notify("item/completed", { item, threadId: t.id, turnId, completedAtMs: Date.now() });
    };
    const closeOpen = () => {
      if (!open) return;
      const o = open;
      open = null;
      if (o.type === "agentMessage") emitDone({ type: "agentMessage", id: o.id, text: o.text, phase: o.phase, memoryCitation: null, delivery: null, questions: null });
      else emitDone({ type: "reasoning", id: o.id, summary: o.raw ? [] : [o.text], content: o.raw ? [o.text] : [] });
    };
    const cmdItem = (id, command, actions, status, extra = {}) => ({
      type: "commandExecution",
      id,
      pluginId: null,
      scriptPath: null,
      command,
      cwd: t.cwd,
      processId: String(nextProc++),
      source: "agent",
      status,
      commandActions: actions,
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      ...extra,
    });
    const relPath = (p) => (p && isAbsolute(p) ? relative(t.cwd, p) || p : p);
    const sink = {
      message(text, o = {}) {
        const phase = o.phase === "commentary" ? "commentary" : "final_answer";
        if (open?.type === "agentMessage" && open.phase !== phase) closeOpen();
        if (open?.type !== "agentMessage") {
          closeOpen();
          open = { type: "agentMessage", id: `msg_mock_${++nextItem}`, text: "", phase };
          emitStart({ type: "agentMessage", id: open.id, text: "", phase, memoryCitation: null, delivery: null, questions: null });
        }
        open.text += text;
        outChars += text.length;
        notify("item/agentMessage/delta", { threadId: t.id, turnId, itemId: open.id, delta: text });
      },
      thought(text, o = {}) {
        // raw:true = the model's raw reasoning (item/reasoning/textDelta -> reasoning `content`), else the summary stream
        const raw = o.raw === true;
        if (open?.type !== "reasoning" || open.raw !== raw) {
          closeOpen();
          open = { type: "reasoning", id: `rs_mock_${++nextItem}`, text: "", raw };
          emitStart({ type: "reasoning", id: open.id, summary: [], content: [] });
          if (!raw) notify("item/reasoning/summaryPartAdded", { threadId: t.id, turnId, itemId: open.id, summaryIndex: 0 });
        }
        open.text += text;
        outChars += text.length;
        if (raw) notify("item/reasoning/textDelta", { threadId: t.id, turnId, itemId: open.id, delta: text, contentIndex: 0 });
        else notify("item/reasoning/summaryTextDelta", { threadId: t.id, turnId, itemId: open.id, delta: text, summaryIndex: 0 });
      },
      toolStart(x) {
        closeOpen();
        const inp = x.input ?? {};
        let item;
        if (x.kind === "edit" || x.kind === "delete" || x.kind === "move") {
          const d = x.diff;
          const path = d?.path ?? inp.file_path ?? "";
          const changes = d
            ? [{ path, kind: d.oldText ? { type: "update", move_path: null } : { type: "add" }, diff: d.oldText ? unifiedDiff(d.oldText, d.newText) : d.newText }]
            : [];
          item = { type: "fileChange", id: x.id, changes, status: "inProgress" };
        } else if (x.kind === "read") {
          const p = inp.path ?? x.locations?.[0]?.path ?? "";
          const cmd = `cat ${relPath(p)}`;
          item = cmdItem(x.id, `/bin/bash -lc ${esc(cmd)}`, [{ type: "read", command: cmd, name: basename(p), path: p }], "inProgress");
        } else if (x.kind === "search") {
          const q = inp.query ?? x.title;
          const cmd = `rg ${esc(q)}`;
          item = cmdItem(x.id, `/bin/bash -lc ${esc(cmd)}`, [{ type: "search", command: cmd, path: null, query: String(q) }], "inProgress");
        } else if (x.kind === "execute") {
          const cmd = inp.command ?? x.title;
          item = cmdItem(x.id, `/bin/bash -lc ${esc(cmd)}`, [{ type: "unknown", command: cmd }], "inProgress");
        } else {
          item = { type: "mcpToolCall", id: x.id, server: x.server ?? "mockkit", tool: x.name ?? (String(x.title ?? "tool").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "tool"), status: "inProgress", arguments: inp, result: null, error: null, durationMs: null };
        }
        tools.set(x.id, { item, startedAt: Date.now(), sent: 0, declined: false });
        emitStart(item);
      },
      toolUpdate(x) {
        const rec = tools.get(x.id);
        if (!rec) return;
        const { item } = rec;
        const text = x.text ?? (typeof x.output === "string" ? x.output : x.output?.stdout);
        if (x.status === "in_progress" || x.status === "pending") {
          if (item.type === "commandExecution" && typeof text === "string" && text.length > rec.sent) {
            notify("item/commandExecution/outputDelta", { threadId: t.id, turnId, itemId: x.id, delta: text.slice(rec.sent) });
            rec.sent = text.length;
          }
          return;
        }
        const ok = x.status === "completed";
        const durationMs = Date.now() - rec.startedAt;
        if (item.type === "commandExecution") {
          if (typeof text === "string" && text.length > rec.sent && x.status !== "pending") {
            notify("item/commandExecution/outputDelta", { threadId: t.id, turnId, itemId: x.id, delta: text.slice(rec.sent) });
          }
          const exit = x.output?.exitCode ?? (ok ? 0 : 1);
          emitDone({ ...item, status: rec.declined ? "declined" : ok ? "completed" : "failed", aggregatedOutput: rec.declined ? null : (text ?? ""), exitCode: rec.declined ? null : exit, durationMs });
        } else if (item.type === "fileChange") {
          const d = x.diff;
          const changes = d
            ? [{ path: d.path, kind: d.oldText ? { type: "update", move_path: null } : { type: "add" }, diff: d.oldText ? unifiedDiff(d.oldText, d.newText) : d.newText }]
            : item.changes;
          emitDone({ ...item, changes, status: rec.declined ? "declined" : ok ? "completed" : "failed" });
        } else {
          emitDone({ ...item, status: ok ? "completed" : "failed", durationMs, result: ok ? { content: [{ type: "text", text: text ?? "" }] } : null, error: ok ? null : { message: text ?? "failed" } });
        }
      },
      plan(entries) {
        closeOpen();
        const status = (s) => (s === "in_progress" ? "inProgress" : s === "completed" ? "completed" : "pending");
        notify("turn/plan/updated", { threadId: t.id, turnId, explanation: null, plan: entries.map((e) => ({ step: e.content ?? e.step ?? "Step", status: status(e.status) })) });
      },
      async exitPlan({ planContent }) {
        closeOpen();
        const id = `${turnId}-plan`;
        emitStart({ type: "plan", id, text: "" });
        for (const chunk of planContent.split(/(?<=\n)/)) notify("item/plan/delta", { threadId: t.id, turnId, itemId: id, delta: chunk });
        emitDone({ type: "plan", id, text: planContent });
        return { outcome: "proposed" };
      },
      async permission(p) {
        // Codex with approvalPolicy "never" (T3 "Full access") never asks: the action simply runs.
        if (t.approvalPolicy === "never") return "allow";
        const rec = tools.get(p.id);
        const startedAtMs = Date.now();
        let method;
        let params;
        if (env.MOCK_CODEX_LEGACY_APPROVALS === "1") {
          // Pre-v2 server requests (T3 still answers them): execCommandApproval / applyPatchApproval, keyed by conversationId.
          if (rec?.item.type === "fileChange") {
            method = "applyPatchApproval";
            params = { conversationId: t.id, callId: p.id, fileChanges: Object.fromEntries(rec.item.changes.map((c) => [c.path, c.kind.type === "add" ? { type: "add", content: c.diff } : { type: "update", unified_diff: c.diff, move_path: null }])), reason: null, grantRoot: null };
          } else {
            method = "execCommandApproval";
            params = { conversationId: t.id, callId: p.id, approvalId: null, command: ["/bin/bash", "-lc", rec?.item?.command ?? p.title], cwd: t.cwd, parsedCmd: [], reason: null };
          }
        } else if (rec?.item.type === "fileChange") {
          method = "item/fileChange/requestApproval";
          params = { threadId: t.id, turnId, itemId: p.id, startedAtMs, reason: null, grantRoot: null };
        } else {
          method = "item/commandExecution/requestApproval";
          const item = rec?.item;
          const command = item?.command ?? p.title;
          params = {
            kind: "command",
            threadId: t.id,
            turnId,
            itemId: p.id,
            startedAtMs,
            environmentId: "local",
            command,
            cwd: t.cwd,
            commandActions: item?.commandActions ?? [{ type: "unknown", command: p.title }],
            availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
          };
        }
        const reqId = nextOutId; // callClient takes this id
        let res;
        try {
          res = await callClient(method, params, signal);
        } catch (e) {
          notify("serverRequest/resolved", { threadId: t.id, requestId: reqId });
          if (e?.name === "AbortError") throw e;
          return "cancel";
        }
        notify("serverRequest/resolved", { threadId: t.id, requestId: reqId });
        const d = res?.decision;
        const name = typeof d === "string" ? d : d && typeof d === "object" ? Object.keys(d)[0] : "";
        if (/^cancel$/i.test(name) || (method === "execCommandApproval" || method === "applyPatchApproval" ? /^abort$/i.test(name) : false)) return "cancel";
        if (/^(decline|denied|abort)/i.test(name)) {
          if (rec) rec.declined = true;
          return "reject";
        }
        return "allow";
      },
      async ask({ questions }) {
        closeOpen();
        const itemId = `call_mock_${++nextItem}`;
        const reqId = nextOutId;
        let res;
        try {
          res = await callClient(
            "item/tool/requestUserInput",
            {
              threadId: t.id,
              turnId,
              itemId,
              questions: questions.map((q, i) => ({
                id: q.id ?? `q${i + 1}`,
                header: q.header ?? "Question",
                question: q.question,
                isOther: q.isOther ?? true,
                isSecret: false,
                options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
              })),
              isBlocking: true,
              autoResolutionMs: null,
            },
            signal,
          );
        } finally {
          notify("serverRequest/resolved", { threadId: t.id, requestId: reqId });
        }
        const answers = {};
        for (const [k, v] of Object.entries(res?.answers ?? {})) answers[k] = Array.isArray(v) ? v : (v?.answers ?? []);
        return { answers };
      },
      // ---- Codex-only IR ops (see lib/ir.mjs) ----
      async elicit(p) {
        // Codex with approvalPolicy "never" does not ask about MCP tool use either.
        if (t.approvalPolicy === "never") return "accept";
        closeOpen();
        const persist = p.persist ?? ["session", "always"];
        const res = await clientRequest("mcpServer/elicitation/request", {
          threadId: t.id,
          turnId,
          serverName: p.server ?? "mockkit",
          mode: "form",
          message: p.message,
          _meta: { ...(p.appName ? { app_name: p.appName } : {}), codex_approval_kind: "mcp_tool_call", ...(persist.length ? { persist } : {}) },
          requestedSchema: { type: "object", properties: {} },
        });
        if (res?.action === "cancel") return "cancel";
        if (res?.action !== "accept") return "decline";
        const per = res?._meta?.persist;
        return per === "session" ? "acceptForSession" : per === "always" ? "acceptAlways" : "accept";
      },
      async grant(p) {
        if (t.approvalPolicy === "never") return "allow";
        closeOpen();
        const abs = (x) => (isAbsolute(x) ? x : resolve(t.cwd, x));
        const permissions = {};
        if (p.read?.length || p.write?.length) permissions.fileSystem = { ...(p.read?.length ? { read: p.read.map(abs) } : {}), ...(p.write?.length ? { write: p.write.map(abs) } : {}) };
        if (p.network) permissions.network = { enabled: true };
        const res = await clientRequest("item/permissions/requestApproval", {
          threadId: t.id,
          turnId,
          itemId: p.id,
          startedAtMs: Date.now(),
          environmentId: "local",
          cwd: t.cwd,
          reason: p.reason ?? null,
          permissions,
        });
        const g = res?.permissions ?? {};
        return g.fileSystem?.read?.length || g.fileSystem?.write?.length || g.network?.enabled ? "allow" : "reject";
      },
      // Spawn an agent. Two wire forms (T3 handles both):
      //  * default: a collabAgentToolCall spawnAgent item registers a child thread, a `wait` item reports the child's final state;
      //  * `path` set: the newer subAgentActivity items (kind started/completed, agentPath = the row title T3 shows).
      // The child then runs its own turn (own threadId/turnId, its items stream with the child ids). `settings` / `reroute` push
      // thread/settings/updated and model/rerouted for the child (T3 only consumes them for subagents: the row's model/effort).
      async subagent(a, runChild) {
        closeOpen();
        const child = newThread({ cwd: t.cwd, model: a.model ?? t.model, restore: false });
        child.parentThreadId = t.id;
        child.agentNickname = a.name ?? "worker";
        child.agentRole = a.role ?? "worker";
        child.approvalPolicy = t.approvalPolicy;
        const activity = typeof a.path === "string" && a.path !== "";
        const base = { type: "collabAgentToolCall", senderThreadId: t.id, prompt: a.prompt ?? "", model: a.model ?? null, reasoningEffort: a.reasoningEffort ?? null };
        const spawn = { ...base, id: a.id, tool: "spawnAgent" };
        const act = (kind, id = a.id) => ({ type: "subAgentActivity", id, agentPath: a.path, agentThreadId: child.id, kind });
        if (activity) {
          emitStart(act("started"));
          await sleep(pace.toolMs, signal);
          notify("thread/started", { thread: threadObject(child) });
          emitDone(act("started"));
        } else {
          emitStart({ ...spawn, status: "inProgress", receiverThreadIds: [], agentsStates: {} });
          await sleep(pace.toolMs, signal);
          emitDone({ ...spawn, status: "completed", receiverThreadIds: [child.id], agentsStates: { [child.id]: { status: "running", message: null } } });
          notify("thread/started", { thread: threadObject(child) });
        }
        const childTurnId = randomUUID();
        const cStart = nowSec();
        const shell = (status, extra = {}) => ({ id: childTurnId, items: [], itemsView: "notLoaded", status, error: null, startedAt: cStart, completedAt: null, durationMs: null, ...extra });
        notify("thread/status/changed", { threadId: child.id, status: { type: "active", activeFlags: [] } });
        notify("turn/started", { threadId: child.id, turn: shell("inProgress") });
        if (a.settings) {
          const m = a.settings.model ?? child.model;
          notify("thread/settings/updated", {
            threadId: child.id,
            threadSettings: {
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              collaborationMode: { mode: "default", settings: { model: m, reasoning_effort: a.settings.effort ?? null } },
              cwd: t.cwd,
              effort: a.settings.effort ?? null,
              model: m,
              modelProvider: "openai",
              sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
              serviceTier: null,
            },
          });
        }
        if (a.reroute) notify("model/rerouted", { threadId: child.id, turnId: childTurnId, fromModel: child.model, toModel: a.reroute, reason: "highRiskCyberActivity" });
        const crt = makeTurnRuntime(child, childTurnId, signal);
        let status = "completed";
        try {
          await runChild(a.steps ?? [], crt.sink);
        } catch (e) {
          if (e?.name === "AbortError" || signal?.aborted) status = "interrupted";
          else throw e;
        }
        crt.closeOpen();
        notify("thread/status/changed", { threadId: child.id, status: { type: "idle" } });
        const cDone = nowSec();
        child.turns.push({ id: childTurnId, prompt: a.prompt ?? "", items: crt.items, status });
        persist(child);
        notify("turn/completed", { threadId: child.id, turn: shell(status, { items: crt.items, itemsView: "summary", completedAt: cDone, durationMs: Math.max(1, (cDone - cStart) * 1000) }) });
        const last = [...crt.items].reverse().find((i) => i.type === "agentMessage");
        if (activity) {
          emitDone(act(status === "completed" ? "completed" : "interrupted", `${a.id}-${status === "completed" ? "completed" : "interrupted"}`));
        } else {
          const waitItem = { ...base, prompt: null, model: null, id: `${a.id}-wait`, tool: "wait", receiverThreadIds: [child.id] };
          emitStart({ ...waitItem, status: "inProgress", agentsStates: { [child.id]: { status: "running", message: null } } });
          emitDone({ ...waitItem, status: "completed", agentsStates: { [child.id]: { status: status === "completed" ? "completed" : "interrupted", message: a.result ?? last?.text ?? null } } });
        }
        if (status === "interrupted") throw abortError();
      },
      // ---- background terminal: a commandExecution item that outlives its turn ---------------------------
      // The item starts inProgress and the turn completes while it runs; T3 keeps the settled turn context alive, projects late output
      // (item/commandExecution/outputDelta) and, when the command finally completes, wakes the agent with a continuation message.
      bgStart(info) {
        closeOpen();
        const item = cmdItem(info.id, `/bin/bash -lc ${esc(info.cmd)}`, [{ type: "unknown", command: info.cmd }], "inProgress");
        const rec = { id: info.id, item, startedAt: Date.now(), sent: 0, threadId: t.id, turnId, kill: info.terminate, done: false };
        bgProcs.set(item.processId, rec);
        emitStart(item);
      },
      bgOutput(info, acc) {
        const rec = [...bgProcs.values()].find((r) => r.id === info.id);
        if (!rec || rec.done || acc.length <= rec.sent) return;
        notify("item/commandExecution/outputDelta", { threadId: t.id, turnId, itemId: info.id, delta: acc.slice(rec.sent) });
        rec.sent = acc.length;
      },
      bgDone(info) {
        const rec = [...bgProcs.values()].find((r) => r.id === info.id);
        if (!rec || rec.done) return; // terminated / closed earlier
        rec.done = true;
        bgProcs.delete(rec.item.processId);
        emitDone({ ...rec.item, status: info.exitCode === 0 ? "completed" : "failed", aggregatedOutput: info.output ?? "", exitCode: info.exitCode ?? 0, durationMs: Date.now() - rec.startedAt });
      },
      bgClose(info) {
        // Codex unloads an idle thread a while after it settles: its terminals die WITHOUT completing their items, then thread/closed.
        const rec = [...bgProcs.values()].find((r) => r.id === info.id);
        if (rec) {
          rec.done = true;
          bgProcs.delete(rec.item.processId);
        }
        notify("thread/closed", { threadId: t.id });
      },
      // dynamicToolCall: a client-side dynamic tool (e.g. node_repl.js). `arguments.persistent:true` would keep it running past the turn.
      async dynamicTool(x) {
        closeOpen();
        const base = { type: "dynamicToolCall", id: x.id, namespace: x.namespace ?? null, tool: x.tool, arguments: x.input ?? {}, contentItems: null, success: null, durationMs: null };
        const t0 = Date.now();
        emitStart({ ...base, status: "inProgress" });
        await sleep(pace.toolMs, signal);
        const ok = x.success !== false;
        emitDone({ ...base, status: ok ? "completed" : "failed", success: ok, durationMs: Date.now() - t0, contentItems: x.output === undefined ? null : [{ type: "inputText", text: String(x.output) }] });
      },
      // Async question: the agent message itself carries the questions (delivery "async"); T3 turns it into a pending question the user can answer
      // OR dismiss, and the answer comes back as an ordinary user message (a new turn). The turn does not wait for it.
      async asyncAsk(a) {
        closeOpen();
        const id = `msg_mock_${++nextItem}`;
        const questions = (a.questions ?? []).map((q) => ({ title: q.title, options: q.options ?? null }));
        const msg = (text) => ({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null, delivery: "async", questions });
        emitStart(msg(""));
        await sleep(pace.toolMs, signal);
        emitDone(msg(a.text ?? ""));
      },
      goal(a) {
        const g = t.goal;
        if (!g) return; // /goal sets one; nothing to update otherwise
        if (a.status) g.status = a.status;
        if (typeof a.tokensUsed === "number") g.tokensUsed = a.tokensUsed;
        if (typeof a.timeUsedSeconds === "number") g.timeUsedSeconds = a.timeUsedSeconds;
        emitGoal(t, turnId);
      },
      async web(x) {
        closeOpen();
        const item = { type: "webSearch", id: x.id, query: x.query, action: { type: "search", query: x.query, queries: null }, results: null };
        emitStart(item);
        await sleep(pace.toolMs, signal);
        emitDone(x.url ? { ...item, action: { type: "openPage", url: x.url } } : item);
      },
      // MCP app: a completed mcpToolCall that points at a ui:// resource; T3 then calls mcpServer/resource/read for the HTML
      // and renders it in a sandboxed frame inside the timeline.
      async mcpApp(x) {
        closeOpen();
        const uri = x.uri ?? `ui://${x.server}/${x.name}.html`;
        mcpResources.set(uri, x.html);
        if (x.tools?.length) {
          const reg = mcpServers.get(x.server) ?? new Map();
          for (const tl of x.tools) reg.set(tl.name, tl);
          mcpServers.set(x.server, reg);
        }
        const base = { type: "mcpToolCall", id: x.id, server: x.server, tool: x.name, arguments: x.input ?? {}, result: null, error: null, durationMs: null, mcpAppUi: { resourceUri: uri, preferredModelDisplayMode: "inline" }, mcpAppResourceUri: uri };
        const t0 = Date.now();
        emitStart({ ...base, status: "inProgress" });
        await sleep(pace.toolMs, signal);
        emitDone({ ...base, status: "completed", durationMs: Date.now() - t0, result: { content: [{ type: "text", text: x.output ?? "ok" }] } });
      },
      retry(r) {
        notify("error", { threadId: t.id, turnId, willRetry: true, error: { message: r.message ?? `Reconnecting... ${r.attempt}/${r.max}`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null } });
      },
    };
    return { sink, closeOpen, items, outChars: () => outChars };
  }

  // ---- turn lifecycle --------------------------------------------------------------------------
  async function scenarioFor(t, req) {
    const tag =
      parseTag(req) ??
      (() => {
        const q = dequeue(t.cwd, { ...process.env, ...env });
        return q ? { id: q.id, args: q.args, text: req, queued: true } : null;
      })();
    const scenarios = await loadScenarios();
    return { tag, scenario: (tag && scenarios.get(tag.id)) || scenarios.get(env.MOCK_DEFAULT_SCENARIO || "echo") };
  }

  async function startTurn(id, params) {
    const t = threads.get(params.threadId) ?? newThread({ id: params.threadId, cwd: params.cwd, model: params.model });
    if (params.cwd && existsSync(params.cwd)) t.cwd = params.cwd;
    if (params.model) t.model = params.model;
    t.approvalPolicy = typeof params.approvalPolicy === "string" ? params.approvalPolicy : "on-request";
    const raw = promptText((params.input ?? []).filter((b) => b?.type === "text"));
    const req = userRequest(raw);
    const { tag, scenario } = await scenarioFor(t, req);
    t.turn += 1;
    const turnId = randomUUID();
    const startedAt = nowSec();
    const turnShell = (status, extra = {}) => ({ id: turnId, items: [], itemsView: "notLoaded", status, error: null, startedAt: status === "inProgress" ? null : startedAt, completedAt: null, durationMs: null, ...extra });
    const ac = new AbortController();
    t.abort = ac;
    t.activeTurnId = turnId;
    reply(id, { turn: turnShell("inProgress") });
    notify("thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId: t.id, turn: turnShell("inProgress", { startedAt }) });
    const userItem = { type: "userMessage", id: `user_mock_${++nextItem}`, clientId: null, content: [{ type: "text", text: raw, text_elements: [] }] };
    notify("item/started", { item: userItem, threadId: t.id, turnId, startedAtMs: Date.now() });
    notify("item/completed", { item: userItem, threadId: t.id, turnId, completedAtMs: Date.now() });

    const rt = makeTurnRuntime(t, turnId, ac.signal);
    const ctx = {
      cwd: t.cwd,
      env: { ...process.env, ...env },
      turn: t.turn,
      args: tag?.args ?? {},
      text: tag?.text ?? req,
      history: t.history,
      sessionId: t.id,
      signal: ac.signal,
      pace,
      log,
      answers: {},
      nextToolId: () => `mock-call-${++nextTool}`,
    };
    log("prompt", { scenario: scenario.id, turn: t.turn, tag: tag?.id ?? null, queued: Boolean(tag?.queued), text: ctx.text.slice(0, 200) });
    let status = "completed";
    let error = null;
    try {
      await runSteps(scenario.steps(ctx), rt.sink, ctx);
    } catch (e) {
      if (e?.name === "AbortError" || ac.signal.aborted) status = "interrupted";
      else if (e instanceof ScenarioError) {
        status = "failed";
        const info = e.kind === "usage_limit" ? "usageLimitExceeded" : /rate.?limit/i.test(e.message) ? "rateLimitExceeded" : "badRequest";
        error = { message: e.message, codexErrorInfo: info, additionalDetails: null };
      } else {
        log("crash", { error: String(e?.stack ?? e) });
        status = "failed";
        error = { message: String(e?.message ?? e), codexErrorInfo: "other", additionalDetails: null };
      }
    }
    rt.closeOpen();
    t.history.push(ctx.text);
    t.abort = null;
    t.activeTurnId = null;
    // token usage (deterministic: ~4 chars/token; input grows with the history). Scenario arg `tokens=<n>` (queue/tag arg)
    // forces this turn's input size, e.g. to fill the context-window meter.
    const forced = Number(ctx.args.tokens);
    const inTok = Number.isFinite(forced) && forced > 0 ? forced : 1200 + 380 * t.history.length + Math.ceil(raw.length / 4);
    const outTok = Math.ceil(rt.outChars() / 4);
    t.tokens = { input: t.tokens.input + inTok, output: t.tokens.output + outTok, cached: t.tokens.cached + Math.floor(inTok * 0.6) };
    const usage = (inp, out, cached) => ({ totalTokens: inp + out, inputTokens: inp, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: out, reasoningOutputTokens: 0 });
    if (t.goal?.status === "active") {
      // an active goal accrues usage per turn (the Goal banner reads tokensUsed / timeUsedSeconds)
      t.goal.tokensUsed += inTok + outTok;
      t.goal.timeUsedSeconds += Math.max(1, nowSec() - startedAt);
      emitGoal(t, turnId);
    }
    notify("thread/tokenUsage/updated", {
      threadId: t.id,
      turnId,
      tokenUsage: { total: usage(t.tokens.input, t.tokens.output, t.tokens.cached), last: usage(inTok, outTok, Math.floor(inTok * 0.6)), modelContextWindow: CONTEXT_WINDOW },
    });
    if (error) {
      if (error.codexErrorInfo === "usageLimitExceeded") {
        // Rate limits first (and a beat to be processed): T3 reads the reset time from the latest snapshot when it terminalizes the turn.
        notify("account/rateLimits/updated", {
          rateLimits: { limitId: "codex", limitName: null, planType: "plus", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: nowSec() + 3 * 3600 }, secondary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: nowSec() + 4 * 86400 }, rateLimitReachedType: "rate_limit_reached" },
        });
        await new Promise((r) => setTimeout(r, 300));
      }
      notify("error", { threadId: t.id, turnId, willRetry: false, error });
    }
    notify("thread/status/changed", { threadId: t.id, status: { type: "idle" } });
    const doneAt = nowSec();
    t.turns.push({ id: turnId, prompt: raw, items: rt.items, status });
    persist(t);
    notify("turn/completed", {
      threadId: t.id,
      turn: { id: turnId, items: rt.items, itemsView: "summary", status, error, startedAt, completedAt: doneAt, durationMs: Math.max(1, (doneAt - startedAt) * 1000) },
    });
  }

  function interrupt(params) {
    const t = threads.get(params.threadId);
    if (t?.abort && (!params.turnId || params.turnId === t.activeTurnId)) t.abort.abort();
  }

  // thread/compact/start: a turn with a contextCompaction item
  async function compact(t) {
    const turnId = randomUUID();
    const startedAt = nowSec();
    const shell = (status, extra = {}) => ({ id: turnId, items: [], itemsView: "notLoaded", status, error: null, startedAt, completedAt: null, durationMs: null, ...extra });
    notify("thread/status/changed", { threadId: t.id, status: { type: "active", activeFlags: [] } });
    notify("turn/started", { threadId: t.id, turn: shell("inProgress") });
    const item = { type: "contextCompaction", id: `compact_mock_${++nextItem}` };
    notify("item/started", { item, threadId: t.id, turnId, startedAtMs: Date.now() });
    notify("item/completed", { item, threadId: t.id, turnId, completedAtMs: Date.now() });
    notify("thread/status/changed", { threadId: t.id, status: { type: "idle" } });
    notify("turn/completed", { threadId: t.id, turn: shell("completed", { items: [item], itemsView: "summary", completedAt: nowSec(), durationMs: 1 }) });
  }

  const turnObjects = (t) =>
    t.turns.map((x) => ({
      id: x.id,
      items: [{ type: "userMessage", id: `user_${x.id}`, clientId: null, content: [{ type: "text", text: x.prompt, text_elements: [] }] }, ...x.items],
      itemsView: "full",
      status: x.status,
      error: null,
      startedAt: t.createdAt,
      completedAt: t.createdAt,
      durationMs: 1,
    }));

  // ---- requests ---------------------------------------------------------------------------------
  async function handleRequest(msg) {
    const { id, method, params = {} } = msg;
    switch (method) {
      case "initialize": {
        if (initialized) return fail(id, -32600, "Already initialized");
        initialized = true;
        const home = env.CODEX_HOME || join(controlDir({ ...process.env, ...env }), "codex-home");
        try {
          mkdirSync(home, { recursive: true });
        } catch {}
        const ver = mode === "old" ? "0.100.0" : CODEX_VERSION;
        return reply(id, { userAgent: `t3code_desktop/${ver} (Mock OS 1.0; mockkit) mockkit (t3code_desktop; 0.1.0)`, codexHome: home, platformFamily: "unix", platformOs: process.platform === "darwin" ? "macos" : process.platform });
      }
      case "account/read": {
        if (mode === "unauth") return reply(id, { account: null, requiresOpenaiAuth: true });
        if (env.MOCK_CODEX_ACCOUNT === "chatgpt") {
          // chatgpt accounts make T3 wait for CODEX_HOME/models_cache.json (fetched_at newer than the spawn): provide it.
          try {
            const home = env.CODEX_HOME || join(controlDir({ ...process.env, ...env }), "codex-home");
            mkdirSync(home, { recursive: true });
            writeFileSync(join(home, "models_cache.json"), JSON.stringify({ fetched_at: new Date().toISOString(), models: [] }));
          } catch {}
          return reply(id, { account: { type: "chatgpt", email: "mock@example.com", planType: env.MOCK_CODEX_PLAN || "plus" }, requiresOpenaiAuth: false });
        }
        return reply(id, { account: { type: "apiKey" }, requiresOpenaiAuth: false });
      }
      case "account/rateLimits/read": {
        // MOCK_CODEX_ACCOUNT=chatgpt adds what a subscription account reports: account id, reset credits, a 5h + weekly window.
        const chat = env.MOCK_CODEX_ACCOUNT === "chatgpt";
        const plan = env.MOCK_CODEX_PLAN || "plus";
        const resetCredits = accountState();
        const snap = { limitId: "codex", limitName: null, planType: plan, primary: { usedPercent: resetCredits.used ? 0 : 23, windowDurationMins: 300, resetsAt: nowSec() + 2 * 3600 }, secondary: { usedPercent: resetCredits.used ? 0 : 41, windowDurationMins: 10080, resetsAt: nowSec() + 5 * 86400 } };
        return reply(id, {
          rateLimits: snap,
          rateLimitsByLimitId: null,
          ...(chat
            ? {
                accountId: "acct_mockkit_0001",
                rateLimitResetCredits: resetCredits.available
                  ? { availableCount: resetCredits.available, credits: Array.from({ length: resetCredits.available }, (_, i) => ({ id: `credit_${i + 1}`, status: "available", resetType: "codexRateLimits", grantedAt: nowSec() - 86400, expiresAt: nowSec() + (10 + i) * 86400, title: "Rate limit reset", description: "Resets your 5 hour and weekly Codex limits" })) }
                  : { availableCount: 0, credits: [] },
              }
            : {}),
        });
      }
      case "account/rateLimitResetCredit/consume": {
        const resetCredits = accountState();
        if (resetCredits.available <= 0) return reply(id, { outcome: "noCredit" });
        // persisted: the next account/rateLimits/read (any process) reports cleared windows and one credit fewer
        saveAccountState({ available: resetCredits.available - 1, used: true });
        return reply(id, { outcome: "reset" });
      }
      case "skills/list":
        return reply(id, { data: (params.cwds ?? [process.cwd()]).map((cwd) => ({ cwd, skills: [], errors: [] })) });
      case "model/list":
        return reply(id, { data: CODEX_MODELS.map(modelEntry), nextCursor: null });
      case "config/read":
        return reply(id, { config: {}, origins: {} });
      case "thread/start": {
        const t = newThread({ cwd: params.cwd, model: params.model, restore: false });
        reply(id, threadResult(t));
        notify("thread/started", { thread: threadObject(t) });
        return;
      }
      case "thread/resume": {
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId, cwd: params.cwd, model: params.model });
        if (params.cwd && existsSync(params.cwd)) t.cwd = params.cwd;
        return reply(id, threadResult(t));
      }
      case "thread/read": {
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        const th = threadObject(t);
        if (params.includeTurns) th.turns = turnObjects(t);
        return reply(id, { thread: th });
      }
      case "thread/fork": {
        const src = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        const t = newThread({ cwd: params.cwd ?? src.cwd, model: params.model ?? src.model, restore: false });
        t.history = [...src.history];
        t.turn = src.turn;
        t.turns = [...src.turns];
        t.forkedFromId = src.id;
        persist(t);
        reply(id, threadResult(t));
        notify("thread/started", { thread: threadObject(t) });
        return;
      }
      case "thread/turns/list": {
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        // T3's rollback pages newest-first (sortDirection "desc", limit n); default stays oldest-first.
        let list = turnObjects(t);
        if (params.sortDirection === "desc") list = list.reverse();
        const start = Number(params.cursor) || 0;
        const limit = Number(params.limit) > 0 ? Number(params.limit) : list.length;
        return reply(id, { data: list.slice(start, start + limit), nextCursor: start + limit < list.length ? String(start + limit) : null });
      }
      case "thread/revert":
      case "thread/rollback": {
        // revert: drop `beforeTurnId` and every later turn; rollback: drop the last `numTurns`.
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        let n;
        if (method === "thread/revert") {
          const idx = t.turns.findIndex((x) => x.id === params.beforeTurnId);
          if (idx < 0) return fail(id, -32602, `Unknown turn ${params.beforeTurnId}`);
          n = t.turns.length - idx;
        } else n = Math.max(0, Number(params.numTurns) || 0);
        if (t.activeTurnId) return fail(id, -32600, "Cannot roll back while a turn is running");
        t.turns.splice(Math.max(0, t.turns.length - n));
        t.history = t.history.slice(0, t.turns.length);
        t.turn = t.turns.length;
        persist(t);
        return reply(id, { thread: { ...threadObject(t), turns: turnObjects(t) } });
      }
      case "thread/compact/start": {
        reply(id, {});
        await compact(threads.get(params.threadId) ?? newThread({ id: params.threadId }));
        return;
      }
      case "turn/start":
        return startTurn(id, params);
      case "turn/interrupt":
        reply(id, {});
        interrupt(params);
        return;
      case "turn/steer":
        return reply(id, { turnId: params.expectedTurnId ?? threads.get(params.threadId)?.activeTurnId ?? "" });
      case "thread/unsubscribe":
        return reply(id, { status: "unsubscribed" });
      case "thread/goal/get": {
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        return reply(id, { goal: t.goal ? { ...t.goal } : null });
      }
      case "thread/goal/set": {
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        if (typeof params.objective === "string" && params.objective.trim()) {
          const at = nowSec();
          t.goal = { threadId: t.id, objective: params.objective.trim(), status: params.status ?? "active", tokenBudget: params.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: at, updatedAt: at };
        } else if (t.goal) {
          if (params.status) t.goal.status = params.status;
          if (params.tokenBudget !== undefined) t.goal.tokenBudget = params.tokenBudget;
        } else return fail(id, -32602, "No goal to update");
        reply(id, { goal: { ...t.goal } });
        emitGoal(t, t.activeTurnId);
        return;
      }
      case "thread/goal/clear": {
        const t = threads.get(params.threadId) ?? newThread({ id: params.threadId });
        const had = Boolean(t.goal);
        t.goal = null;
        persist(t);
        reply(id, { cleared: had });
        if (had) notify("thread/goal/cleared", { threadId: t.id });
        return;
      }
      case "thread/inject_items":
      case "thread/unarchive":
        return reply(id, {});
      case "thread/backgroundTerminals/list": {
        const data = [...bgProcs.values()].filter((r) => !r.done && r.threadId === params.threadId).map((r) => ({ processId: r.item.processId, command: r.item.command, cwd: r.item.cwd, itemId: r.id, turnId: r.turnId }));
        return reply(id, { data, nextCursor: null });
      }
      case "thread/backgroundTerminals/terminate": {
        // Stop / interrupt: kill the terminal; its item completes as failed (exit 143), the thread stays alive.
        const rec = bgProcs.get(String(params.processId));
        if (!rec || rec.done || rec.threadId !== params.threadId) return reply(id, { terminated: false });
        rec.done = true;
        bgProcs.delete(String(params.processId));
        rec.kill?.();
        log("bgTask", { state: "terminated", processId: params.processId });
        notify("item/completed", { item: { ...rec.item, status: "failed", aggregatedOutput: null, exitCode: 143, durationMs: Date.now() - rec.startedAt }, threadId: rec.threadId, turnId: rec.turnId, completedAtMs: Date.now() });
        return reply(id, { terminated: true });
      }
      case "mcpServerStatus/list": {
        // Real tool data for the MCP servers a scenario registered (mcpApp tools): T3 reads it to decide whether an MCP app may call a tool.
        const want = params.serverName;
        const data = [...mcpServers.entries()]
          .filter(([name]) => !want || name === want)
          .map(([name, tools]) => ({
            name,
            authStatus: "unsupported",
            tools: Object.fromEntries([...tools.values()].map((tl) => [tl.name, { name: tl.name, title: tl.title ?? null, description: tl.description ?? null, inputSchema: tl.inputSchema ?? { type: "object", properties: {} }, ...(tl.annotations ? { annotations: tl.annotations } : {}), ...(tl.visibility ? { _meta: { ui: { visibility: tl.visibility } } } : {}) }])),
            resources: [],
            resourceTemplates: [],
          }));
        return reply(id, { data, nextCursor: null });
      }
      case "feedback/upload": {
        // `/feedback [reason]` in the composer (Codex only): T3 shows "Feedback sent to OpenAI" + the returned thread id
        const feedbackId = randomUUID();
        try {
          mkdirSync(ctlDir, { recursive: true });
          appendFileSync(join(ctlDir, "feedback.jsonl"), `${JSON.stringify({ feedbackId, ...params })}\n`);
        } catch {}
        log("feedback", { feedbackId, reason: params.reason ?? null, classification: params.classification, threadId: params.threadId });
        return reply(id, { threadId: feedbackId });
      }
      case "mcpServer/resource/read": {
        const html = mcpResources.get(params.uri);
        if (html === undefined) return fail(id, -32602, `Unknown resource ${params.uri}`);
        return reply(id, { contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: html }] });
      }
      case "mcpServer/tool/call": {
        const tool = mcpServers.get(params.server)?.get(params.tool);
        if (!tool) return reply(id, { content: [{ type: "text", text: "ok (mock MCP tool)" }], isError: false });
        const out = typeof tool.result === "function" ? tool.result(params.arguments ?? {}) : (tool.result ?? "ok");
        log("mcpToolCall", { server: params.server, tool: params.tool, arguments: params.arguments ?? {} });
        if (out && typeof out === "object") return reply(id, { content: out.content ?? [{ type: "text", text: JSON.stringify(out) }], ...(out.structuredContent ? { structuredContent: out.structuredContent } : {}), isError: out.isError === true });
        return reply(id, { content: [{ type: "text", text: String(out) }], isError: false });
      }
      default:
        return fail(id, -32601, `Unhandled request: ${method}`);
    }
  }

  const rl = createInterface({ input });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    log("in", { raw: line.length > 4000 ? `${line.slice(0, 4000)}...` : line });
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      handleRequest(msg).catch((e) => {
        log("crash", { error: String(e?.stack ?? e) });
        fail(msg.id, -32603, String(e?.message ?? e));
      });
    } else if (msg.method) {
      // notifications from the client ("initialized"): nothing to do
    } else if (msg.id !== undefined) {
      const p = pendingOut.get(msg.id);
      if (p) {
        pendingOut.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "client error"));
        else p.resolve(msg.result);
      }
    }
  });
  return new Promise((resolveP) =>
    rl.on("close", () => {
      for (const t of threads.values()) t.abort?.abort();
      resolveP();
    }),
  );
}

// ---- `codex exec ... --output-schema F --output-last-message F -` (text generation) -------------------
// argv = everything after "exec". stdin = prompt. Writes valid JSON to the --output-last-message file.
export async function execText({ argv, stdin, env = process.env, stdout = process.stdout }) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const outFile = flag("--output-last-message") ?? flag("-o");
  const schemaFile = flag("--output-schema");
  let keys;
  if (schemaFile) {
    const schema = readJson(resolve(schemaFile));
    if (schema?.properties) keys = Object.keys(schema.properties);
  }
  const prompt = stdin ?? "";
  const json = textGenJson(prompt, await loadScenarios(), { keys });
  // fill any required key the stub does not know with a harmless string
  const obj = JSON.parse(json);
  for (const k of keys ?? []) if (!(k in obj)) obj[k] = "mock";
  const text = JSON.stringify(obj);
  makeLog(env.MOCK_LOG, { agent: "codex-exec" })("textgen", { reply: text, keys });
  if (outFile) writeFileSync(outFile, text);
  stdout.write(`${text}\n`);
  return text;
}
