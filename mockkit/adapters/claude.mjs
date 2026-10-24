// Zero-dep mock `claude` CLI (stream-json over stdio) that plays provider-neutral scenarios.
// Targets the T3 Code `claudeAgent` driver, which drives @anthropic-ai/claude-agent-sdk; the SDK spawns
// `<binaryPath> --output-format stream-json --verbose --input-format stream-json [--permission-mode M]
//  [--session-id=ID | --resume=ID] [--model M] --permission-prompt-tool stdio --include-partial-messages ...`.
// Wire (recon: sdk.mjs 0.3.276 + t3code apps/server/src/orchestration-v2/testkit/fixtures/claude_*):
//   stdin  (SDK -> CLI): {type:"control_request",request_id,request:{subtype:initialize|interrupt|set_model|set_permission_mode|get_usage|...}}
//                        {type:"control_response",response:{subtype:"success"|"error",request_id,response}}   (answers to our can_use_tool)
//                        {type:"user",message:{role:"user",content},uuid?,parent_tool_use_id:null}
//   stdout (CLI -> SDK): {type:"control_response",...}  {type:"control_request",request_id,request:{subtype:"can_use_tool",tool_name,input,tool_use_id,...}}
//                        {type:"system",subtype:"init",...} {type:"stream_event",event} {type:"assistant",message} {type:"user",message(tool_result)}
//                        {type:"rate_limit_event",...} {type:"result",subtype,...}
// Also: `printText()` for `claude -p --output-format json --json-schema S` (T3 text generation: titles, commit messages)
// and `authStatus()` for `claude auth status`. No network, no ANTHROPIC_API_KEY, no credentials read or written.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScenarioError, runSteps } from "../lib/ir.mjs";
import { controlDir, hold as holdGate } from "../lib/hold.mjs";
import { makeLog } from "../lib/log.mjs";
import { abortError, makePace } from "../lib/pace.mjs";
import { dequeue } from "../lib/queue.mjs";
import { parseTag, promptText, userRequest } from "../lib/select.mjs";
import { textGenJson } from "../lib/textgen.mjs";
import { loadScenarios } from "../scenarios/index.mjs";

// >= recommendedRange (2.1.280) and >= the min version of every current model in T3's bundled manifest (haiku 5.5 needs 2.1.293).
export const CLAUDE_VERSION = "2.1.300";
export const MOCK_ACCOUNT = { email: "mock@example.invalid", organization: "Mock Org", subscriptionType: "max", tokenSource: "claude.ai", apiKeySource: "none", apiProvider: "firstParty" };
const CONTEXT_WINDOW = 200000;
// Must exceed the 450 ms chunk pacing of the live-stream scenario (S40): else every 2-word chunk closes its own text block (own T3 message).
const IDLE_CLOSE_MS = Number(process.env.MOCK_CLAUDE_IDLE_MS) || 800;
const DEFAULT_MODEL = "claude-sonnet-5-5";

// `models` of the initialize response (T3 takes its picker list from its own manifest, this is for protocol completeness).
export const CLAUDE_MODELS = [
  { value: "default", displayName: "Default (recommended)", description: "Mock Claude: Sonnet 5.5 (mockkit, keyless)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsAdaptiveThinking: true },
  { value: "claude-opus-5-5", displayName: "Claude Opus 5.5", description: "Mock Claude: most capable (mockkit, keyless)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true },
  { value: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", description: "Mock Claude: balanced (mockkit, keyless)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsAdaptiveThinking: true },
  { value: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", description: "Mock Claude: fastest (mockkit, keyless)", supportsEffort: false, supportsAdaptiveThinking: false },
];

export const CLAUDE_COMMANDS = [
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation", argumentHint: "" },
  { name: "review", description: "Review a pull request", argumentHint: "[pr-number]" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch", argumentHint: "" },
  { name: "context", description: "Show current context usage", argumentHint: "" },
  { name: "cost", description: "Show the total cost and duration of the current session", argumentHint: "" },
];

const TOOLS = ["Task", "Bash", "Glob", "Grep", "ExitPlanMode", "Read", "Edit", "Write", "NotebookEdit", "WebFetch", "TodoWrite", "WebSearch", "AskUserQuestion"];

const nowIso = () => new Date().toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- argv ----------------------------------------------------------------------------------------
const VALUE_FLAGS = new Set(["--model", "--permission-mode", "--session-id", "--resume", "--effort", "--output-format", "--input-format", "--json-schema", "--permission-prompt-tool", "--thinking", "--settings", "--tools", "--allowedTools", "--disallowedTools", "--append-system-prompt", "--max-turns", "--debug-file", "--add-dir", "--mcp-config", "--setting-sources", "--thinking-display", "--resume-session-at"]);

// -> { flags: {name: value|true}, positional: [] }; understands `--k=v`, `--k v` (known value flags only) and bare `--k`.
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p") flags["--print"] = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(0, eq)] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(a) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a] = argv[++i];
      else flags[a] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

// ---- tool mapping (IR tool -> Claude Code tool_use) -----------------------------------------------
// Smallest edit region (1 line of context) so Edit's old_string/new_string look like a real Edit call.
export function editInput(path, oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const lo = Math.max(0, p - 1);
  const ctx = Math.min(s, 1);
  return { file_path: path, old_string: a.slice(lo, a.length - s + ctx).join("\n"), new_string: b.slice(lo, b.length - s + ctx).join("\n"), replace_all: false };
}

// Single-hunk structuredPatch (3 lines of context), the shape Claude's Edit/Write tool_use_result carries.
export function structuredPatch(oldText, newText) {
  const split = (t) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = split(oldText);
  const b = split(newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const start = Math.max(0, p - 3);
  const aEnd = a.length - s;
  const bEnd = b.length - s;
  const tail = Math.min(3, s);
  const lines = [...a.slice(start, p).map((l) => ` ${l}`), ...a.slice(p, aEnd).map((l) => `-${l}`), ...b.slice(p, bEnd).map((l) => `+${l}`), ...a.slice(aEnd, aEnd + tail).map((l) => ` ${l}`)];
  return [{ oldStart: start + 1, oldLines: aEnd + tail - start, newStart: start + 1, newLines: bEnd + tail - start, lines }];
}

const numbered = (text) => text.split("\n").map((l, i) => `${String(i + 1).padStart(6)}→${l}`).join("\n");

// IR toolStart payload -> { name, input }
export function toolFor(x) {
  const inp = x.input ?? {};
  switch (x.kind) {
    case "read":
      return { name: "Read", input: { file_path: inp.path ?? inp.file_path ?? x.locations?.[0]?.path ?? "" } };
    case "edit":
    case "delete":
    case "move": {
      const d = x.diff;
      if (d && d.oldText) return { name: "Edit", input: editInput(d.path, d.oldText, d.newText) };
      return { name: "Write", input: { file_path: d?.path ?? inp.file_path ?? "", content: d?.newText ?? inp.content ?? "" } };
    }
    case "execute":
      return { name: "Bash", input: { command: inp.command ?? x.title, ...(x.title && x.title !== inp.command ? { description: x.title } : {}) } };
    case "search":
      return { name: "Grep", input: { pattern: inp.pattern ?? inp.query ?? x.title, ...(inp.path ? { path: inp.path } : {}), output_mode: "content" } };
    case "fetch":
      return inp.url ? { name: "WebFetch", input: { url: inp.url, prompt: inp.prompt ?? "Summarize this page" } } : { name: "WebSearch", input: { query: inp.query ?? x.title } };
    default: {
      const slug = (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "tool";
      if (x.server && x.name) return { name: `mcp__${slug(x.server)}__${slug(x.name)}`, input: inp };
      if (x.name && /^[A-Za-z][A-Za-z0-9_]*$/.test(x.name)) return { name: x.name, input: inp };
      const t = String(x.title ?? "Tool");
      return { name: /^[A-Za-z][A-Za-z0-9_]*$/.test(t) ? t : `mcp__mockkit__${t.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "tool"}`, input: inp };
    }
  }
}

const verbFor = (name, input) => {
  if (name === "Bash") return `run: ${input.command}`;
  if (name === "Edit") return `edit ${input.file_path}`;
  if (name === "Write") return `create ${input.file_path}`;
  if (name === "Read") return `read ${input.file_path}`;
  return `use ${name}`;
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const usageObj = (inp, out, cached = 0) => ({ input_tokens: inp, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: out, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard", cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: "", iterations: null, speed: "standard" });

// ---- the stream-json server --------------------------------------------------------------------------
export function serveClaude({ input = process.stdin, output = process.stdout, env = process.env, argv = process.argv.slice(2) } = {}) {
  const { flags } = parseArgs(argv);
  const log = makeLog(env.MOCK_LOG, { agent: "claude" });
  const pace = makePace(env);
  const mode = env.MOCK_CLI_MODE || "ready";
  const stateDir = join(controlDir({ ...process.env, ...env }), "claude-sessions");

  // ---- session (one CLI process = one session; `--resume=<id>` restores turn count + history across respawns) ----
  const sid = String(flags["--resume"] && flags["--resume"] !== true ? flags["--resume"] : flags["--session-id"] && flags["--session-id"] !== true ? flags["--session-id"] : randomUUID());
  const saved = readJson(join(stateDir, `${sid}.json`));
  const cwdOk = (p) => p && existsSync(p) && statSync(p).isDirectory();
  const session = {
    id: sid,
    cwd: process.cwd(),
    model: typeof flags["--model"] === "string" ? flags["--model"] : saved?.model || DEFAULT_MODEL,
    permissionMode: typeof flags["--permission-mode"] === "string" ? flags["--permission-mode"] : saved?.permissionMode || "default",
    turn: saved?.turn ?? 0,
    history: saved?.history ?? [],
    tokens: saved?.tokens ?? { input: 0, output: 0, cached: 0 },
    allowedTools: new Set(),
    abort: null,
    costUsd: saved?.costUsd ?? 0,
    turnUuids: saved?.turnUuids ?? [], // last root assistant uuid per turn: the cursors T3 rolls back to (`--resume-session-at`)
    baseTokens: saved?.baseTokens ?? 1200, // context size after the last /compact (input tokens grow from here)
    baseTurns: saved?.baseTurns ?? 0, // history length at that point
    lastInTok: saved?.lastInTok ?? 0,
    goal: saved?.goal ?? null, // /goal objective + evaluator checks
    mcpServers: new Set(),
    busy: false, // a user/wake turn is running (background completions wait for the next idle moment)
  };
  if (!cwdOk(session.cwd)) session.cwd = process.cwd();
  // Rewind (T3 "Edit from here"): it closes the CLI and respawns it with `--resume=<id> --resume-session-at=<assistant uuid of the kept turn>`;
  // the mock drops every later turn from the persisted session, so counting / quoted history continue from the kept turn.
  const rewindTo = typeof flags["--resume-session-at"] === "string" ? flags["--resume-session-at"] : null;
  let rewound = null;
  if (rewindTo && saved) {
    const i = session.turnUuids.indexOf(rewindTo);
    if (i >= 0) {
      session.history = session.history.slice(0, i + 1);
      session.turnUuids = session.turnUuids.slice(0, i + 1);
      session.turn = i + 1;
      rewound = { kept: i + 1, dropped: (saved.turn ?? 0) - (i + 1) };
      session.baseTurns = Math.min(session.baseTurns, session.history.length);
    } else rewound = { kept: session.turn, dropped: 0, unknownCursor: true };
  }
  const persist = () => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify({ id: sid, model: session.model, permissionMode: session.permissionMode, turn: session.turn, history: session.history, tokens: session.tokens, costUsd: session.costUsd, turnUuids: session.turnUuids, baseTokens: session.baseTokens, baseTurns: session.baseTurns, lastInTok: session.lastInTok, goal: session.goal }));
    } catch {}
  };

  const label = (o) => {
    if (o.type === "assistant" || o.type === "user") {
      const b = o.message?.content?.[0];
      return `${o.type}:${b?.type ?? "msg"}${b?.name ? `:${b.name}` : ""}`;
    }
    if (o.type === "stream_event") return `stream:${o.event?.type}${o.event?.delta?.type ? `:${o.event.delta.type}` : ""}`;
    if (o.type === "control_request") return `control_request:${o.request?.subtype}`;
    if (o.type === "control_response") return `control_response:${o.response?.subtype}`;
    return `${o.type}${o.subtype ? `:${o.subtype}` : ""}`;
  };
  // `method` makes mock-frame summaries in the CI log readable (scenario.mjs prints frame.method)
  let lastRootAssistant = null;
  const write = (obj) => {
    if (obj.type === "assistant" && !obj.parent_tool_use_id && obj.message?.model !== "<synthetic>") lastRootAssistant = obj.uuid;
    log("out", { frame: { method: label(obj), ...obj } });
    output.write(`${JSON.stringify(obj)}\n`);
  };
  const base = () => ({ session_id: session.id, uuid: randomUUID() });
  const pendingOut = new Map();
  let nextReq = 0;
  let nextTool = 0;
  let nextMsg = 0;

  // ---- tool_result `user` frames ---------------------------------------------------------------------------------
  function toolResultFrame(toolUseId, content, isError, structured, parent = null) {
    write({ type: "user", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: isError }] }, parent_tool_use_id: parent, ...base(), timestamp: nowIso(), ...(structured ? { tool_use_result: structured } : {}) });
  }

  // can_use_tool control request -> { behavior, message?, interrupt?, updatedInput?, updatedPermissions? }
  function askPermission(toolName, inputObj, toolUseId, extra, signal) {
    return new Promise((resolveP, reject) => {
      const request_id = `mock_perm_${++nextReq}_${randomUUID().slice(0, 8)}`;
      pendingOut.set(request_id, { resolve: resolveP, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (pendingOut.delete(request_id)) {
            write({ type: "control_cancel_request", request_id });
            reject(abortError());
          }
        },
        { once: true },
      );
      write({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: toolName, input: inputObj, tool_use_id: toolUseId, ...extra } });
    });
  }

  // ---- background tasks (Bash run_in_background / Monitor): roster frames, completions wake the session after the turn ----------
  // Real Claude Code: `background_tasks_changed` rosters + `task_started` while the turn runs; when the command ends the CLI
  // (outside any turn) sends roster + `task_updated` + `task_notification`, then wakes itself with an `init` / assistant / `result` turn
  // (recon: T3 testkit fixtures claude_background_task_wake, claude_background_monitor_wake, claude_background_subagent_lifecycle).
  const bgRunning = new Map(); // claudeTaskId -> { info, startedAt }
  const bgCompleted = []; // finished commands waiting to be reported (the report happens between turns)
  const bgRoster = () => write({ type: "system", subtype: "background_tasks_changed", tasks: [...bgRunning.values()].map((t) => ({ task_id: t.info.claudeTaskId, task_type: "local_bash", description: t.info.description })), ...base() });
  const taskOutputFile = (taskId) => join(stateDir, sid, "tasks", `${taskId}.output`);
  const lastLine = (out) => String(out ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "(no output)";

  // ---- IR sink -> Claude frames ---------------------------------------------------------------------------------------
  function makeTurnRuntime({ signal, inTokens, parent = null }) {
    const trf = (toolUseId, content, isError, structured) => toolResultFrame(toolUseId, content, isError, structured, parent);
    const model = session.model;
    let msg = null; // current API response { id, started, index, stopReason }
    let open = null; // open streamed content block { type, text, index }
    let outChars = 0;
    let lastText = "";
    const tools = new Map();
    const assistantFrame = (content, extra = {}) => ({
      type: "assistant",
      message: { model, id: msg.id, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, stop_details: null, usage: usageObj(inTokens, 1), context_management: null },
      parent_tool_use_id: parent,
      ...base(),
      ...extra,
    });
    const stream = (event) => write({ type: "stream_event", event, parent_tool_use_id: parent, ...base() });
    const ensureMsg = () => {
      if (msg) return;
      msg = { id: `msg_mock_${++nextMsg}_${randomUUID().slice(0, 6)}`, index: 0 };
      stream({ type: "message_start", message: { id: msg.id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: usageObj(inTokens, 1) } });
    };
    const endMsg = (stopReason) => {
      if (!msg) return;
      stream({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: Math.ceil(outChars / 4) } });
      stream({ type: "message_stop" });
      msg = null;
    };
    // T3 renders assistant text from the completed `assistant` snapshot only (stream text_delta is ignored), so a block the
    // model "pauses" in (hold / sleep / permission wait) is closed after IDLE_CLOSE_MS without a delta, like a finished text block.
    let idle = null;
    const closeOpen = () => {
      clearTimeout(idle);
      if (!open) return;
      const o = open;
      open = null;
      stream({ type: "content_block_stop", index: o.index });
      if (o.type === "text") {
        lastText = o.text;
        write(assistantFrame([{ type: "text", text: o.text }]));
      } else write(assistantFrame([{ type: "thinking", thinking: o.text, signature: "mock-signature" }]));
    };
    const openBlock = (type) => {
      if (open?.type === type) return;
      closeOpen();
      ensureMsg();
      open = { type, text: "", index: msg.index++ };
      stream({ type: "content_block_start", index: open.index, content_block: type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" } });
    };
    // one tool_use block = one assistant snapshot; the API response ends right after it (tool round)
    const emitToolUse = (id, name, inputObj, extra) => {
      closeOpen();
      ensureMsg();
      write(assistantFrame([{ type: "tool_use", id, name, input: inputObj, caller: { type: "direct" } }], extra));
      endMsg("tool_use");
    };

    const sink = {
      message(text) {
        openBlock("text");
        open.text += text;
        outChars += text.length;
        stream({ type: "content_block_delta", index: open.index, delta: { type: "text_delta", text } });
        clearTimeout(idle);
        idle = setTimeout(closeOpen, IDLE_CLOSE_MS);
      },
      thought(text) {
        openBlock("thinking");
        open.text += text;
        outChars += text.length;
        stream({ type: "content_block_delta", index: open.index, delta: { type: "thinking_delta", thinking: text } });
        clearTimeout(idle);
        idle = setTimeout(closeOpen, IDLE_CLOSE_MS);
      },
      toolStart(x) {
        const { name, input: inputObj } = toolFor(x);
        tools.set(x.id, { name, input: inputObj, kind: x.kind, diff: x.diff, startedAt: Date.now() });
        // MCP tools carry presentation meta (T3: tool title + server badge; `mcp__claude_ai_<Server>__<tool>` is normalised to `mcp__<server>__<tool>`)
        const meta = x.display || x.serverDisplay ? { tool_use_meta: [{ id: x.id, display_name: x.display ?? x.title, server_display_name: x.serverDisplay ?? x.server }] } : undefined;
        if (x.server) session.mcpServers.add(String(x.server));
        emitToolUse(x.id, name, inputObj, meta);
      },
      toolUpdate(x) {
        const rec = tools.get(x.id);
        if (!rec) return;
        if (x.status === "in_progress" || x.status === "pending") return; // Claude emits one tool_result per tool_use
        const ok = x.status === "completed";
        const text = x.text ?? (typeof x.output === "string" ? x.output : (x.output?.stdout ?? ""));
        if (rec.denied) {
          trf(x.id, rec.denied, true);
          return;
        }
        if (rec.name === "Bash") {
          const code = x.output?.exitCode ?? (ok ? 0 : 1);
          trf(x.id, ok ? text : `Exit code ${code}\n${text}`, !ok, { stdout: text, stderr: "", interrupted: false, isImage: false, noOutputExpected: !text });
        } else if (rec.name === "Read" && ok && x.image) {
          // Read on an image file: the tool_result carries an image block (T3 additionally previews workspace images)
          trf(x.id, [{ type: "image", source: { type: "base64", media_type: x.image.mediaType, data: x.image.base64 } }], false, { type: "image", file: { base64: x.image.base64, type: x.image.mediaType, originalSize: x.image.bytes } });
        } else if (rec.name === "Read") {
          trf(x.id, ok ? numbered(text) : text, !ok, ok ? { type: "text", file: { filePath: rec.input.file_path, content: text, numLines: text.split("\n").length, startLine: 1, totalLines: text.split("\n").length } } : undefined);
        } else if (rec.name === "Edit" || rec.name === "Write") {
          const d = x.diff ?? rec.diff;
          const oldText = d?.oldText ?? "";
          const created = rec.name === "Write";
          trf(
            x.id,
            ok ? (created ? `File created successfully at: ${rec.input.file_path}` : `The file ${rec.input.file_path} has been updated successfully.`) : text,
            !ok,
            ok ? (created ? { type: "create", filePath: rec.input.file_path, content: d?.newText ?? "", structuredPatch: [], originalFile: null } : { filePath: rec.input.file_path, oldString: rec.input.old_string, newString: rec.input.new_string, originalFile: oldText, structuredPatch: structuredPatch(oldText, d?.newText ?? ""), userModified: false, replaceAll: false }) : undefined,
          );
        } else trf(x.id, text, !ok);
      },
      plan(entries) {
        const id = `toolu_mock_${++nextTool}`;
        const todos = entries.map((e) => ({ content: e.content ?? e.step ?? "Step", status: e.status ?? "pending", activeForm: e.activeForm ?? `Working on: ${e.content ?? e.step ?? "step"}` }));
        emitToolUse(id, "TodoWrite", { todos });
        trf(id, "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable", false, { oldTodos: [], newTodos: todos });
      },
      async exitPlan({ planContent }) {
        const id = `toolu_mock_${++nextTool}`;
        emitToolUse(id, "ExitPlanMode", { plan: planContent });
        // ExitPlanMode always needs the client's say (even under bypassPermissions). T3 captures the plan and denies the tool.
        let res;
        try {
          res = await askPermission("ExitPlanMode", { plan: planContent }, id, { title: "Claude has a plan ready for your review", display_name: "Exit plan mode" }, signal);
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          res = { behavior: "deny", message: String(e?.message ?? e) };
        }
        if (res?.behavior === "allow") trf(id, "User has approved your plan. You can now start coding.", false, { plan: planContent, isAgent: false });
        else trf(id, res?.message ?? "The user doesn't want to proceed with this tool use.", true);
        return { outcome: res?.behavior === "allow" ? "approved" : "proposed" };
      },
      async permission(p) {
        const rec = tools.get(p.id);
        const name = rec?.name ?? p.title ?? "Tool";
        const inputObj = rec?.input ?? p.input ?? {};
        const edit = name === "Edit" || name === "Write";
        // Claude Code semantics: bypassPermissions never asks; acceptEdits auto-allows file edits; "always allow" rules skip the prompt.
        if (session.permissionMode === "bypassPermissions" || session.permissionMode === "dontAsk" || (session.permissionMode === "acceptEdits" && edit) || session.allowedTools.has(name)) return "allow";
        const suggestions = edit
          ? [{ type: "setMode", mode: "acceptEdits", destination: "session" }]
          : [{ type: "addRules", rules: [{ toolName: name, ruleContent: name === "Bash" ? `${String(inputObj.command ?? "").split(/\s+/)[0]}:*` : undefined }], behavior: "allow", destination: "localSettings" }];
        let res;
        try {
          res = await askPermission(name, inputObj, p.id, { title: `Claude wants to ${verbFor(name, inputObj)}`, display_name: name, description: name === "Bash" ? (inputObj.description ?? undefined) : undefined, permission_suggestions: suggestions }, signal);
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          return "cancel";
        }
        if (res?.behavior === "allow") {
          for (const up of res.updatedPermissions ?? []) {
            if (up?.type === "setMode" && typeof up.mode === "string") session.permissionMode = up.mode;
            if (up?.type === "addRules") for (const r of up.rules ?? []) if (r?.toolName) session.allowedTools.add(r.toolName);
          }
          return "allow";
        }
        if (rec) rec.denied = res?.message || "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
        return res?.interrupt ? "cancel" : "reject";
      },
      async ask({ questions }) {
        const id = `toolu_mock_${++nextTool}`;
        const qs = questions.map((q, i) => ({ question: q.question, header: String(q.header ?? `Question ${i + 1}`).slice(0, 12), multiSelect: q.multiSelect === true, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description || o.label })) }));
        emitToolUse(id, "AskUserQuestion", { questions: qs });
        let res;
        try {
          res = await askPermission("AskUserQuestion", { questions: qs }, id, { title: qs[0]?.question, display_name: "Ask user question" }, signal);
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          res = { behavior: "deny", message: String(e?.message ?? e) };
        }
        if (res?.behavior !== "allow") {
          trf(id, res?.message ?? "User declined to answer questions.", true);
          return { answers: {} };
        }
        // SDK answers: { "<question text>": "<label>[, <label>]" }; the IR wants arrays keyed by question
        const raw = res.updatedInput?.answers ?? {};
        const answers = {};
        for (const [k, v] of Object.entries(raw)) answers[k] = typeof v === "string" ? (v ? v.split(/,\s*/) : []) : Array.isArray(v) ? v : [];
        const summary = Object.entries(raw).map(([k, v]) => `"${k}"="${Array.isArray(v) ? v.join(", ") : v}"`).join(", ");
        trf(id, `User has answered your questions: ${summary}. You can now continue with the user's answers in mind.`, false, { questions: qs, answers: raw });
        return { answers };
      },

      // ---- Claude-gaps ops -------------------------------------------------------------------------------------------------
      // WebSearch / WebFetch tool rows (T3 `web_search` turn items: patterns + result links / fetched snippet)
      web({ id, query, url, fetch, results, prompt }) {
        const started = Date.now();
        if (fetch) {
          const target = url ?? "https://example.invalid/";
          const body = results?.[0]?.snippet ?? `# ${query ?? "Fetched page"}\n\nMock page content fetched from ${target}.`;
          emitToolUse(id, "WebFetch", { url: target, prompt: prompt ?? query ?? "Summarize this page" });
          trf(id, body, false, { bytes: body.length, code: 200, codeText: "OK", result: body, durationMs: Math.max(1, Date.now() - started), url: target });
          return;
        }
        const links = results ?? (url ? [{ title: query, url }] : [{ title: `${query} - overview`, url: "https://example.invalid/search-result" }]);
        emitToolUse(id, "WebSearch", { query });
        const text = `Web search results for query: "${query}"\n\nLinks: ${JSON.stringify(links)}\n\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.`;
        trf(id, text, false, { query, results: [{ tool_use_id: `srvtoolu_${id}`, content: links }, `Searched for "${query}".`], durationSeconds: 1.4 });
      },
      // Skill tool (model-invoked skill; a user `/skill` message ends here as well)
      skill({ id, name, args }) {
        emitToolUse(id, "Skill", { skill: name, ...(args ? { args } : {}) });
        trf(id, `Launching skill: ${name}`, false, { success: true, commandName: name });
      },
      // lifecycle hooks: hook_started / hook_response system frames (T3's ClaudeAdapterV2 has no handler for them: not rendered)
      hook({ event, name, output, exitCode, outcome }) {
        const hook_id = randomUUID();
        const hook_name = name ?? `${event}:startup`;
        write({ type: "system", subtype: "hook_started", hook_id, hook_name, hook_event: event, ...base() });
        write({ type: "system", subtype: "hook_response", hook_id, hook_name, hook_event: event, output: output ?? "", stdout: output ?? "", stderr: "", exit_code: exitCode ?? 0, outcome: outcome ?? ((exitCode ?? 0) === 0 ? "success" : "error"), ...base() });
      },
      // /compact (or auto-compaction): status compacting -> status {compact_result} -> compact_boundary + synthetic summary
      // (T3: "Compacting context" -> "Context compacted" row, context meter drops to post_tokens)
      async compact({ trigger, pre, post, summary, hold }) {
        closeOpen();
        endMsg("end_turn");
        const t0 = Date.now();
        const preTokens = pre ?? Math.max(session.lastInTok, 24000);
        const postTokens = post ?? 1192;
        write({ type: "system", subtype: "status", status: "compacting", ...base() });
        if (hold) await holdGate(hold, { env: { ...process.env, ...env }, signal, log });
        else await new Promise((r) => setTimeout(r, pace.name === "fast" ? 50 : 2500));
        write({ type: "system", subtype: "status", status: null, compact_result: "success", ...base() });
        write({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: trigger ?? "manual", pre_tokens: preTokens, post_tokens: postTokens, cumulative_dropped_tokens: preTokens - postTokens, duration_ms: Date.now() - t0 }, logical_parent_uuid: lastRootAssistant ?? randomUUID(), ...base() });
        write({ type: "user", message: { role: "user", content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summary ?? `The user and assistant exchanged ${session.history.length} message(s) in the mock session.`}` }, parent_tool_use_id: null, timestamp: nowIso(), isReplay: false, isSynthetic: true, ...base() });
        write({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, parent_tool_use_id: null, timestamp: nowIso(), isReplay: true, ...base() });
        session.baseTokens = postTokens;
        session.baseTurns = session.history.length;
        session.lastInTok = postTokens;
      },
      // informational system notice (T3 `system_notice` row)
      notice({ text, level }) {
        write({ type: "system", subtype: "informational", content: text, level: level ?? "warning", ...base() });
      },
      // transient API failure the CLI retries by itself (T3 retry row, cleared when output resumes)
      retry({ message, attempt, max }) {
        closeOpen();
        write({ type: "system", subtype: "api_retry", attempt, max_retries: max, retry_delay_ms: 2000 * attempt, error_status: 529, error: "server_error", ...base() });
        outChars += String(message ?? "").length;
      },
      // Agent (Task) tool: the subagent runs `steps` with frames tagged parent_tool_use_id = the Agent tool_use id (T3: child thread + subagent row)
      async subagent({ id, name, prompt, steps, model, result, agentType }, runChild) {
        const taskId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const started = Date.now();
        const description = name ?? "worker";
        const kind = agentType ?? "general-purpose";
        emitToolUse(id, "Agent", { description, subagent_type: kind, ...(model ? { model } : {}), prompt: prompt ?? description, run_in_background: false });
        write({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: id, description, subagent_type: kind, is_backgrounded: false, spawn_depth: 1, task_type: "local_agent", prompt: prompt ?? description, ...base() });
        write({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt ?? description }] }, parent_tool_use_id: id, ...base(), timestamp: nowIso(), subagent_type: kind, task_description: description });
        const child = makeTurnRuntime({ signal, inTokens, parent: id });
        let toolUses = 0;
        const origStart = child.sink.toolStart;
        child.sink.toolStart = (x) => {
          origStart(x);
          toolUses += 1;
          const rec = child.tool(x.id);
          write({ type: "system", subtype: "task_progress", task_id: taskId, tool_use_id: id, description: `Running ${x.title ?? rec?.name ?? "tool"}`, subagent_type: kind, usage: { total_tokens: 18000 + 400 * toolUses, tool_uses: toolUses, duration_ms: Date.now() - started }, last_tool_name: rec?.name ?? "Tool", ...base() });
        };
        try {
          await runChild(steps ?? [], child.sink);
        } finally {
          child.closeOpen();
          child.endMsg("end_turn");
        }
        const text = result ?? child.lastText();
        const usage = { total_tokens: 20000 + 400 * toolUses, tool_uses: toolUses, duration_ms: Date.now() - started };
        write({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status: "completed", end_time: Date.now() }, ...base() });
        write({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: id, status: "completed", output_file: taskOutputFile(taskId), summary: text, usage, ...base() });
        trf(id, [{ type: "text", text: `${text}\nagentId: ${taskId} (use SendMessage with to: '${taskId}', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: ${usage.total_tokens}\ntool_uses: ${toolUses}\nduration_ms: ${usage.duration_ms}</usage>` }], false, { status: "completed", prompt: prompt ?? description, agentId: taskId, content: [{ type: "text", text }], totalDurationMs: usage.duration_ms, totalTokens: usage.total_tokens, totalToolUseCount: toolUses });
      },
      // background Bash / Monitor
      bgStart(info) {
        const monitor = info.kind === "monitor";
        info.claudeTaskId = `b${randomUUID().replace(/-/g, "").slice(0, 8)}`;
        bgRunning.set(info.claudeTaskId, { info, startedAt: Date.now() });
        try {
          mkdirSync(join(stateDir, sid, "tasks"), { recursive: true });
          writeFileSync(taskOutputFile(info.claudeTaskId), "");
        } catch {}
        if (monitor) emitToolUse(info.id, "Monitor", { description: info.description, command: info.cmd, timeout_ms: info.persistent ? 3600000 : 30000, ...(info.persistent ? { persistent: true } : {}) });
        else emitToolUse(info.id, "Bash", { command: info.cmd, description: info.description, run_in_background: true });
        bgRoster();
        write({ type: "system", subtype: "task_started", task_id: info.claudeTaskId, tool_use_id: info.id, description: info.description, is_backgrounded: true, task_type: "local_bash", ...base() });
        if (monitor) trf(info.id, `Monitor started (task ${info.claudeTaskId}, ${info.persistent ? "persistent until stopped" : "expires in 30s unless the source ends first"}). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`, false, { taskId: info.claudeTaskId, timeoutMs: info.persistent ? 3600000 : 30000, persistent: info.persistent });
        else trf(info.id, `Command running in background with ID: ${info.claudeTaskId}. Output is being written to: ${taskOutputFile(info.claudeTaskId)}. You will be notified when it completes. To check interim output, use Read on that file path.`, false, { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: info.claudeTaskId });
      },
      bgDone(done) {
        bgCompleted.push(done);
        queueMicrotask(() => flushBg());
      },
      // TaskOutput (read what a background task printed so far) / TaskStop (kill it)
      bgControl({ id, action, task }) {
        const cid = task.claudeTaskId;
        const h = task.handle ?? {};
        if (action === "output") {
          emitToolUse(id, "TaskOutput", { task_id: cid, block: false, timeout: 5000 });
          const status = h.done ? "completed" : "running";
          trf(id, `<retrieval_status>${h.done ? "success" : "not_ready"}</retrieval_status>\n\n<task_id>${cid}</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>${status}</status>\n\n<output>\n${h.out ?? ""}</output>`, false, { retrieval_status: h.done ? "success" : "not_ready", task: { task_id: cid, task_type: "local_bash", status, description: task.description, output: h.out ?? "", exitCode: h.done ? 0 : null } });
          return;
        }
        emitToolUse(id, "TaskStop", { task_id: cid });
        bgRunning.delete(cid);
        bgRoster();
        write({ type: "system", subtype: "task_updated", task_id: cid, patch: { status: "killed", end_time: Date.now() }, ...base() });
        write({ type: "system", subtype: "task_notification", task_id: cid, tool_use_id: task.id, status: "stopped", output_file: taskOutputFile(cid), summary: task.description, ...base() });
        const payload = { message: `Successfully stopped task: ${cid} (${task.description})`, task_id: cid, task_type: "local_bash", command: task.description };
        trf(id, JSON.stringify(payload), false, payload);
      },
    };
    return {
      sink,
      tool: (id) => tools.get(id),
      closeOpen,
      endMsg,
      outChars: () => outChars,
      lastText: () => lastText,
      synthetic(text, extra = {}) {
        closeOpen();
        endMsg("end_turn");
        msg = { id: randomUUID(), index: 0 };
        write({ type: "assistant", message: { id: msg.id, container: null, model: "<synthetic>", role: "assistant", stop_details: null, stop_reason: "stop_sequence", stop_sequence: "", type: "message", usage: usageObj(0, 0), content: [{ type: "text", text }], context_management: null }, parent_tool_use_id: null, ...base(), ...extra });
        msg = null;
      },
    };
  }

  // ---- turns ---------------------------------------------------------------------------------------------------
  // `/name args` as the last line of a user message: T3 sends a bare "/compact" for its Compact action and `/skill args` for a `$skill` mention.
  function slashOf(text) {
    const last = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
    const m = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/.exec(last);
    return m ? { name: m[1], args: (m[2] ?? "").trim() } : null;
  }

  // Skills the real CLI would load: <cwd>/.claude/skills/<name>/SKILL.md (+ $CLAUDE_CONFIG_DIR/skills when set). T3 discovers the same files for its `$` picker.
  const skillRoots = () => [join(session.cwd, ".claude", "skills"), ...(env.CLAUDE_CONFIG_DIR ? [join(env.CLAUDE_CONFIG_DIR, "skills")] : [])]; // never the real ~/.claude (keyless + hermetic)
  function skillInfo(name) {
    for (const root of skillRoots()) {
      const file = join(root, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const body = readFileSync(file, "utf8");
      const description = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      return { name, file, relPath: file.startsWith(`${session.cwd}/`) ? file.slice(session.cwd.length + 1) : file, description, body };
    }
    return null;
  }
  function listSkills() {
    const out = [];
    for (const root of skillRoots()) {
      try {
        for (const d of readdirSync(root)) if (existsSync(join(root, d, "SKILL.md")) && !out.includes(d)) out.push(d);
      } catch {}
    }
    return out;
  }

  async function scenarioFor(req, raw) {
    const scenarios = await loadScenarios();
    const explicit = parseTag(req);
    if (explicit) return { tag: explicit, scenario: scenarios.get(explicit.id) || scenarios.get("echo") };
    const slash = slashOf(req) ?? slashOf(raw);
    if (slash?.name === "compact") {
      const q = dequeue(session.cwd, { ...process.env, ...env }); // a driver may queue `compact hold=<gate>` to pin the running state
      return { tag: { id: "compact", args: q?.id === "compact" ? q.args : {}, text: req, queued: Boolean(q) }, scenario: scenarios.get("compact"), slash };
    }
    if (slash?.name === "goal") {
      // `/goal <objective>`: the CLI evaluates a goal after every turn; the default work scenario is goal-work (queue entry may override / add hold=<gate>)
      const q = dequeue(session.cwd, { ...process.env, ...env });
      const tag = q ? { id: q.id, args: q.args, text: req, queued: true } : { id: "goal-work", args: {}, text: req };
      return { tag, scenario: scenarios.get(tag.id) || scenarios.get("goal-work"), slash };
    }
    const skill = slash ? skillInfo(slash.name) : null;
    if (skill) return { tag: { id: "skill-run", args: {}, text: req }, scenario: scenarios.get("skill-run"), slash, skill };
    const q = dequeue(session.cwd, { ...process.env, ...env });
    const tag = q ? { id: q.id, args: q.args, text: req, queued: true } : null;
    return { tag, scenario: (tag && scenarios.get(tag.id)) || scenarios.get(env.MOCK_DEFAULT_SCENARIO || "echo") };
  }

  const initFrame = () => ({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: CLAUDE_VERSION,
    cwd: session.cwd,
    tools: TOOLS,
    mcp_servers: [...session.mcpServers].map((name) => ({ name, status: "connected" })),
    model: session.model,
    permissionMode: session.permissionMode,
    slash_commands: [...CLAUDE_COMMANDS.map((c) => c.name), ...listSkills()],
    output_style: "default",
    skills: listSkills(),
    plugins: [],
    agents: [],
    fast_mode_state: "off",
    ...base(),
  });

  // PNG / GIF header -> pixel size (enough for "I can see a 64x48 image")
  function imageInfo(block) {
    const buf = Buffer.from(String(block.source?.data ?? ""), "base64");
    const info = { mediaType: block.source?.media_type ?? "image/png", bytes: buf.length };
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) Object.assign(info, { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
    else if (buf.length > 10 && buf.toString("latin1", 0, 3) === "GIF") Object.assign(info, { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) });
    return info;
  }

  function resultCommon({ inTok, outTok, started, uuid, turns = 1 }) {
    session.tokens = { input: session.tokens.input + inTok, output: session.tokens.output + outTok, cached: session.tokens.cached + Math.floor(inTok * 0.6) };
    session.costUsd += Math.round((inTok * 3 + outTok * 15) / 10) / 100000;
    const dur = Math.max(1, Date.now() - started);
    const modelUsage = { [session.model]: { inputTokens: session.tokens.input, outputTokens: session.tokens.output, cacheReadInputTokens: session.tokens.cached, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: session.costUsd, contextWindow: CONTEXT_WINDOW, maxOutputTokens: 32000 } };
    return { duration_ms: dur, duration_api_ms: Math.floor(dur * 0.8), num_turns: turns, session_id: session.id, total_cost_usd: session.costUsd, usage: usageObj(inTok, outTok, Math.floor(inTok * 0.6)), modelUsage, permission_denials: [], fast_mode_state: "off", uuid: randomUUID(), ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}) };
  }

  async function runTurn({ raw, uuid, images = [] }) {
    const req = userRequest(raw);
    const { tag, scenario, skill, slash } = await scenarioFor(req, raw);
    const isCompact = scenario.id === "compact" && slash?.name === "compact";
    if (!isCompact) session.turn += 1;
    const started = Date.now();
    const ac = new AbortController();
    session.abort = ac;
    session.busy = true;
    lastRootAssistant = null;
    // deterministic usage (~4 chars/token, input grows with history; /compact resets the base); queue/tag arg `tokens=<n>` forces the input size
    const forced = Number(tag?.args?.tokens);
    const inTok = Number.isFinite(forced) && forced > 0 ? forced : session.baseTokens + 380 * Math.max(0, session.history.length - session.baseTurns) + Math.ceil(raw.length / 4);
    session.lastInTok = inTok;
    write(initFrame());
    const rt = makeTurnRuntime({ signal: ac.signal, inTokens: inTok });
    const ctx = {
      cwd: session.cwd,
      env: { ...process.env, ...env },
      turn: session.turn,
      args: tag?.args ?? {},
      text: tag?.text ?? req,
      history: session.history,
      sessionId: session.id,
      signal: ac.signal,
      pace,
      log,
      answers: {},
      images,
      skill: skill ? { name: skill.name, args: slash?.args ?? "", description: skill.description, path: skill.relPath, body: skill.body } : undefined,
      rewound,
      nextToolId: () => `toolu_mock_${++nextTool}`,
    };
    log("prompt", { scenario: scenario.id, turn: session.turn, tag: tag?.id ?? null, queued: Boolean(tag?.queued), text: ctx.text.slice(0, 200), images: images.length });
    // `/goal` (Claude reports it only through synthetic transcript lines: "Goal set: X", "Stop hook feedback" user frames, "Goal active: X (N turns)",
    // "Goal cleared: X"; T3 ClaudeAdapterV2.nextClaudeGoal turns them into the thread goal)
    const isGoal = slash?.name === "goal" && !parseTag(req);
    let skipSteps = false;
    rt.sink.goal = (a) => {
      const g = session.goal;
      if (!g || a.status !== "complete") return;
      session.goal = null;
      rt.synthetic(`Goal cleared: ${g.objective}`);
    };
    if (isGoal) {
      const arg = slash.args;
      if (/^(clear|stop|off|reset|none|cancel)$/i.test(arg)) {
        const g = session.goal;
        session.goal = null;
        rt.synthetic(g ? `Goal cleared: ${g.objective}` : "No goal set.");
        skipSteps = true;
      } else if (!arg) {
        rt.synthetic(session.goal ? `Goal active: ${session.goal.objective} (${session.goal.checks} turns)` : "No goal set.");
        skipSteps = true;
      } else {
        session.goal = { objective: arg, checks: 0 };
        rt.synthetic(`Goal set: ${arg}`);
      }
    }
    let failure = null; // { kind, message } | "interrupted"
    try {
      if (!skipSteps) await runSteps(scenario.steps(ctx), rt.sink, ctx);
      if (isGoal && !skipSteps && session.goal) {
        session.goal.checks += 1;
        write({ type: "user", message: { role: "user", content: [{ type: "text", text: `Stop hook feedback:\n[${session.goal.objective}]: The goal is not met yet.` }] }, parent_tool_use_id: null, isSynthetic: true, timestamp: nowIso(), ...base() });
        rt.synthetic(`Goal active: ${session.goal.objective} (${session.goal.checks} turn${session.goal.checks === 1 ? "" : "s"})`);
      }
    } catch (e) {
      if (e?.name === "AbortError" || ac.signal.aborted) failure = "interrupted";
      else if (e instanceof ScenarioError) failure = { kind: e.kind === "usage_limit" ? "usage_limit" : /rate.?limit/i.test(e.message) ? "rate_limit" : "api", message: e.message };
      else {
        log("crash", { error: String(e?.stack ?? e) });
        failure = { kind: "api", message: String(e?.message ?? e) };
      }
    }
    rt.closeOpen();
    rt.endMsg("end_turn");
    if (!isCompact) {
      session.history.push(ctx.text);
      session.turnUuids.push(lastRootAssistant ?? randomUUID());
    }
    rewound = null;
    session.abort = null;
    const outTok = Math.max(1, Math.ceil(rt.outChars() / 4));
    const common = resultCommon({ inTok, outTok, started, uuid, turns: isCompact ? 0 : 1 });
    if (failure === "interrupted") {
      write({ type: "result", subtype: "error_during_execution", is_error: true, stop_reason: null, errors: ["Request was interrupted by the user."], terminal_reason: "aborted_streaming", ...common });
    } else if (failure?.kind === "usage_limit" || failure?.kind === "rate_limit") {
      const resetsAt = nowSec() + 3 * 3600;
      const info = { status: "rejected", resetsAt, rateLimitType: "five_hour", overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false, utilization: 1 };
      write({ type: "rate_limit_event", rate_limit_info: info, ...base() });
      const text = "You've hit your limit · resets in 3 hours";
      rt.synthetic(text, { error: "rate_limit", api_error_params: { rate_limit_info: info } });
      write({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: text, stop_reason: "stop_sequence", terminal_reason: "blocking_limit", ...common });
    } else if (failure) {
      const text = `API Error: ${failure.message}`;
      rt.synthetic(text, { error: "invalid_request" });
      write({ type: "result", subtype: "success", is_error: true, api_error_status: 400, result: text, stop_reason: "stop_sequence", terminal_reason: "api_error", ...common });
    } else if (isCompact) {
      write({ type: "result", subtype: "success", is_error: false, api_error_status: null, result: "", stop_reason: null, local_command: "compact", ...common });
    } else {
      write({ type: "result", subtype: "success", is_error: false, api_error_status: null, result: rt.lastText(), stop_reason: "end_turn", terminal_reason: "completed", ...common });
    }
    session.busy = false;
    persist();
  }

  // A background command ended while nobody was talking: roster + task_updated + task_notification, then the CLI wakes itself
  // (init / assistant / result without a user message) to read the result.
  async function runWake(done) {
    session.busy = true;
    const started = Date.now();
    const ac = new AbortController();
    session.abort = ac;
    const lines = [];
    for (const c of done) {
      const cid = c.claudeTaskId;
      bgRunning.delete(cid);
      try {
        writeFileSync(taskOutputFile(cid), c.output ?? "");
      } catch {}
      const ok = c.exitCode === 0;
      const monitor = c.kind === "monitor";
      bgRoster();
      write({ type: "system", subtype: "task_updated", task_id: cid, patch: { status: ok ? "completed" : "failed", end_time: Date.now() }, ...base() });
      write({ type: "system", subtype: "task_notification", task_id: cid, tool_use_id: c.id, status: ok ? "completed" : "failed", output_file: taskOutputFile(cid), summary: monitor ? `Monitor "${c.description}" stream ended` : `Background command "${c.description}" ${ok ? "completed" : "failed"} (exit code ${c.exitCode})`, ...base() });
      lines.push(`${c.description} finished (exit ${c.exitCode}). Last line: ${lastLine(c.output)}`);
    }
    const inTok = session.baseTokens + 380 * Math.max(0, session.history.length - session.baseTurns);
    write(initFrame());
    const rt = makeTurnRuntime({ signal: ac.signal, inTokens: inTok });
    rt.sink.message(lines.join("\n"));
    rt.closeOpen();
    rt.endMsg("end_turn");
    session.abort = null;
    write({ type: "result", subtype: "success", is_error: false, api_error_status: null, result: rt.lastText(), stop_reason: "end_turn", terminal_reason: "completed", ...resultCommon({ inTok, outTok: Math.max(1, Math.ceil(rt.outChars() / 4)), started }) });
    session.busy = false;
    persist();
  }

  // serial turn queue (the real CLI queues user messages that arrive mid-turn)
  const turnQueue = [];
  let draining = false;
  function flushBg() {
    if (!bgCompleted.length || session.busy || draining) return;
    turnQueue.push({ wake: bgCompleted.splice(0) });
    void drain();
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (turnQueue.length) {
        const item = turnQueue.shift();
        try {
          await (item.wake ? runWake(item.wake) : runTurn(item));
        } catch (e) {
          session.busy = false;
          log("crash", { error: String(e?.stack ?? e) });
        }
      }
    } finally {
      draining = false;
      flushBg();
    }
  }

  // ---- control requests (SDK -> CLI) -------------------------------------------------------------------------------
  const usageResponse = () => ({
    session: { total_cost_usd: session.costUsd, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: MOCK_ACCOUNT.subscriptionType,
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 23, resets_at: new Date(Date.now() + 2 * 3600_000).toISOString() },
      seven_day: { utilization: 41, resets_at: new Date(Date.now() + 5 * 86400_000).toISOString() },
    },
  });
  const account = () => (mode === "unauth" ? { tokenSource: "none", apiKeySource: "none" } : MOCK_ACCOUNT);

  function handleControl(msg) {
    const { request_id, request = {} } = msg;
    const ok = (response = {}) => write({ type: "control_response", response: { subtype: "success", request_id, response } });
    const err = (error) => write({ type: "control_response", response: { subtype: "error", request_id, error } });
    switch (request.subtype) {
      case "initialize":
        return ok({ commands: CLAUDE_COMMANDS, agents: [], output_style: "default", available_output_styles: ["default"], models: CLAUDE_MODELS, account: account(), fast_mode_state: "off" });
      case "interrupt":
        session.abort?.abort();
        return ok();
      case "set_permission_mode":
        if (typeof request.mode === "string") session.permissionMode = request.mode;
        return ok({ mode: session.permissionMode });
      case "set_model":
        if (typeof request.model === "string" && request.model) session.model = request.model === "default" ? DEFAULT_MODEL : request.model;
        return ok();
      case "get_usage":
        return ok(usageResponse());
      case "mcp_status":
        return ok({ mcpServers: [...session.mcpServers].map((name) => ({ name, status: "connected", serverInfo: { name, version: "1.0.0" }, scope: "dynamic", tools: [] })) });
      case "mcp_set_servers": // T3 registers its own `t3-code` orchestration MCP server on every session; the mock "connects" and never calls it
        for (const name of Object.keys(request.servers ?? {})) session.mcpServers.add(name);
        return ok({ added: Object.keys(request.servers ?? {}), removed: [], errors: {} });
      case "get_context_usage":
        return ok({ categories: [], totalTokens: session.tokens.input, maxTokens: CONTEXT_WINDOW, rawMaxTokens: CONTEXT_WINDOW, percentage: Math.min(100, (session.tokens.input / CONTEXT_WINDOW) * 100), gridRows: [], model: session.model, memoryFiles: [], mcpTools: [], agents: [] });
      case "background_tasks":
        return ok({ backgrounded: false });
      case "stop_task":
      case "apply_flag_settings":
      case "set_max_thinking_tokens":
      case "reload_plugins":
      case "reload_skills":
      case "update_settings":
      case "set_cwd":
      case "seed_read_state":
      case "cancel_async_message":
      case "rename_session":
        return ok();
      default:
        return err(`mock claude: unsupported control request ${request.subtype}`);
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
    switch (msg.type) {
      case "control_request":
        return handleControl(msg);
      case "control_response": {
        const r = msg.response ?? {};
        const p = pendingOut.get(r.request_id);
        if (!p) return;
        pendingOut.delete(r.request_id);
        if (r.subtype === "error") p.reject(new Error(r.error ?? "client error"));
        else p.resolve(r.response ?? {});
        return;
      }
      case "control_cancel_request": {
        const p = pendingOut.get(msg.request_id);
        if (p) {
          pendingOut.delete(msg.request_id);
          p.reject(abortError());
        }
        return;
      }
      case "user": {
        const content = msg.message?.content;
        const raw = promptText(typeof content === "string" ? content : Array.isArray(content) ? content : []);
        const images = Array.isArray(content) ? content.filter((b) => b?.type === "image" && b.source?.data).map(imageInfo) : [];
        turnQueue.push({ raw, uuid: typeof msg.uuid === "string" ? msg.uuid : undefined, images });
        void drain();
        return;
      }
      default:
        return; // keep_alive, update_environment_variables, ...
    }
  });
  return new Promise((resolveP) =>
    rl.on("close", () => {
      session.abort?.abort();
      resolveP();
    }),
  );
}

// ---- `claude -p --output-format json --json-schema S ...` (text generation: prompt on stdin) -----------------------------
export async function printText({ argv, stdin, env = process.env, stdout = process.stdout }) {
  const { flags } = parseArgs(argv);
  let keys;
  if (typeof flags["--json-schema"] === "string") {
    try {
      const schema = JSON.parse(flags["--json-schema"]);
      if (schema?.properties) keys = Object.keys(schema.properties);
    } catch {}
  }
  const json = textGenJson(stdin ?? "", await loadScenarios(), { keys });
  const obj = JSON.parse(json);
  for (const k of keys ?? []) if (!(k in obj)) obj[k] = "mock";
  makeLog(env.MOCK_LOG, { agent: "claude-print" })("textgen", { reply: JSON.stringify(obj), keys });
  const sessionId = randomUUID();
  const out = { type: "result", subtype: "success", is_error: false, api_error_status: null, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: "", stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage: usageObj(1, 1), modelUsage: {}, permission_denials: [], structured_output: obj, uuid: randomUUID() };
  stdout.write(`${JSON.stringify(out)}\n`);
  return out;
}

// `claude auth status` (JSON by default on current CLIs)
export function authStatus({ env = process.env, stdout = process.stdout } = {}) {
  const unauth = (env.MOCK_CLI_MODE || "ready") === "unauth";
  const out = unauth ? { loggedIn: false, authMethod: "none", apiProvider: "firstParty" } : { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: MOCK_ACCOUNT.email, orgName: MOCK_ACCOUNT.organization, subscriptionType: MOCK_ACCOUNT.subscriptionType };
  stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return unauth ? 1 : 0;
}
