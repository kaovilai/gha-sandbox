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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScenarioError, runSteps } from "../lib/ir.mjs";
import { controlDir } from "../lib/hold.mjs";
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
const IDLE_CLOSE_MS = 350;
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
const VALUE_FLAGS = new Set(["--model", "--permission-mode", "--session-id", "--resume", "--effort", "--output-format", "--input-format", "--json-schema", "--permission-prompt-tool", "--thinking", "--settings", "--tools", "--allowedTools", "--disallowedTools", "--append-system-prompt", "--max-turns", "--debug-file", "--add-dir", "--mcp-config", "--setting-sources", "--thinking-display"]);

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
    default: {
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
  };
  if (!cwdOk(session.cwd)) session.cwd = process.cwd();
  const persist = () => {
    try {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${sid}.json`), JSON.stringify({ id: sid, model: session.model, permissionMode: session.permissionMode, turn: session.turn, history: session.history, tokens: session.tokens, costUsd: session.costUsd }));
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
  const write = (obj) => {
    log("out", { frame: { method: label(obj), ...obj } });
    output.write(`${JSON.stringify(obj)}\n`);
  };
  const base = () => ({ session_id: session.id, uuid: randomUUID() });
  const pendingOut = new Map();
  let nextReq = 0;
  let nextTool = 0;
  let nextMsg = 0;

  // ---- tool_result `user` frames ---------------------------------------------------------------------------------
  function toolResultFrame(toolUseId, content, isError, structured) {
    write({ type: "user", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: isError }] }, parent_tool_use_id: null, ...base(), timestamp: nowIso(), ...(structured ? { tool_use_result: structured } : {}) });
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

  // ---- IR sink -> Claude frames ---------------------------------------------------------------------------------------
  function makeTurnRuntime({ signal, inTokens }) {
    const model = session.model;
    let msg = null; // current API response { id, started, index, stopReason }
    let open = null; // open streamed content block { type, text, index }
    let outChars = 0;
    let lastText = "";
    const tools = new Map();
    const assistantFrame = (content, extra = {}) => ({
      type: "assistant",
      message: { model, id: msg.id, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, stop_details: null, usage: usageObj(inTokens, 1), context_management: null },
      parent_tool_use_id: null,
      ...base(),
      ...extra,
    });
    const stream = (event) => write({ type: "stream_event", event, parent_tool_use_id: null, ...base() });
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
    const emitToolUse = (id, name, inputObj) => {
      closeOpen();
      ensureMsg();
      write(assistantFrame([{ type: "tool_use", id, name, input: inputObj, caller: { type: "direct" } }]));
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
        emitToolUse(x.id, name, inputObj);
      },
      toolUpdate(x) {
        const rec = tools.get(x.id);
        if (!rec) return;
        if (x.status === "in_progress" || x.status === "pending") return; // Claude emits one tool_result per tool_use
        const ok = x.status === "completed";
        const text = x.text ?? (typeof x.output === "string" ? x.output : (x.output?.stdout ?? ""));
        if (rec.denied) {
          toolResultFrame(x.id, rec.denied, true);
          return;
        }
        if (rec.name === "Bash") {
          const code = x.output?.exitCode ?? (ok ? 0 : 1);
          toolResultFrame(x.id, ok ? text : `Exit code ${code}\n${text}`, !ok, { stdout: text, stderr: "", interrupted: false, isImage: false, noOutputExpected: !text });
        } else if (rec.name === "Read") {
          toolResultFrame(x.id, ok ? numbered(text) : text, !ok, ok ? { type: "text", file: { filePath: rec.input.file_path, content: text, numLines: text.split("\n").length, startLine: 1, totalLines: text.split("\n").length } } : undefined);
        } else if (rec.name === "Edit" || rec.name === "Write") {
          const d = x.diff ?? rec.diff;
          const oldText = d?.oldText ?? "";
          const created = rec.name === "Write";
          toolResultFrame(
            x.id,
            ok ? (created ? `File created successfully at: ${rec.input.file_path}` : `The file ${rec.input.file_path} has been updated successfully.`) : text,
            !ok,
            ok ? (created ? { type: "create", filePath: rec.input.file_path, content: d?.newText ?? "", structuredPatch: [], originalFile: null } : { filePath: rec.input.file_path, oldString: rec.input.old_string, newString: rec.input.new_string, originalFile: oldText, structuredPatch: structuredPatch(oldText, d?.newText ?? ""), userModified: false, replaceAll: false }) : undefined,
          );
        } else toolResultFrame(x.id, text, !ok);
      },
      plan(entries) {
        const id = `toolu_mock_${++nextTool}`;
        const todos = entries.map((e) => ({ content: e.content ?? e.step ?? "Step", status: e.status ?? "pending", activeForm: e.activeForm ?? `Working on: ${e.content ?? e.step ?? "step"}` }));
        emitToolUse(id, "TodoWrite", { todos });
        toolResultFrame(id, "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable", false, { oldTodos: [], newTodos: todos });
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
        if (res?.behavior === "allow") toolResultFrame(id, "User has approved your plan. You can now start coding.", false, { plan: planContent, isAgent: false });
        else toolResultFrame(id, res?.message ?? "The user doesn't want to proceed with this tool use.", true);
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
          toolResultFrame(id, res?.message ?? "User declined to answer questions.", true);
          return { answers: {} };
        }
        // SDK answers: { "<question text>": "<label>[, <label>]" }; the IR wants arrays keyed by question
        const raw = res.updatedInput?.answers ?? {};
        const answers = {};
        for (const [k, v] of Object.entries(raw)) answers[k] = typeof v === "string" ? (v ? v.split(/,\s*/) : []) : Array.isArray(v) ? v : [];
        const summary = Object.entries(raw).map(([k, v]) => `"${k}"="${Array.isArray(v) ? v.join(", ") : v}"`).join(", ");
        toolResultFrame(id, `User has answered your questions: ${summary}. You can now continue with the user's answers in mind.`, false, { questions: qs, answers: raw });
        return { answers };
      },
    };
    return {
      sink,
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
  async function scenarioFor(req) {
    const tag =
      parseTag(req) ??
      (() => {
        const q = dequeue(session.cwd, { ...process.env, ...env });
        return q ? { id: q.id, args: q.args, text: req, queued: true } : null;
      })();
    const scenarios = await loadScenarios();
    return { tag, scenario: (tag && scenarios.get(tag.id)) || scenarios.get(env.MOCK_DEFAULT_SCENARIO || "echo") };
  }

  const initFrame = () => ({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: CLAUDE_VERSION,
    cwd: session.cwd,
    tools: TOOLS,
    mcp_servers: [],
    model: session.model,
    permissionMode: session.permissionMode,
    slash_commands: CLAUDE_COMMANDS.map((c) => c.name),
    output_style: "default",
    skills: [],
    plugins: [],
    agents: [],
    fast_mode_state: "off",
    ...base(),
  });

  async function runTurn({ raw, uuid }) {
    const req = userRequest(raw);
    const { tag, scenario } = await scenarioFor(req);
    session.turn += 1;
    const started = Date.now();
    const ac = new AbortController();
    session.abort = ac;
    // deterministic usage (~4 chars/token, input grows with history); queue/tag arg `tokens=<n>` forces the input size
    const forced = Number(tag?.args?.tokens);
    const inTok = Number.isFinite(forced) && forced > 0 ? forced : 1200 + 380 * session.history.length + Math.ceil(raw.length / 4);
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
      nextToolId: () => `toolu_mock_${++nextTool}`,
    };
    log("prompt", { scenario: scenario.id, turn: session.turn, tag: tag?.id ?? null, queued: Boolean(tag?.queued), text: ctx.text.slice(0, 200) });
    let failure = null; // { kind, message } | "interrupted"
    try {
      await runSteps(scenario.steps(ctx), rt.sink, ctx);
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
    session.history.push(ctx.text);
    session.abort = null;
    const outTok = Math.max(1, Math.ceil(rt.outChars() / 4));
    session.tokens = { input: session.tokens.input + inTok, output: session.tokens.output + outTok, cached: session.tokens.cached + Math.floor(inTok * 0.6) };
    const cost = Math.round((inTok * 3 + outTok * 15) / 10) / 100000;
    session.costUsd += cost;
    const dur = Math.max(1, Date.now() - started);
    const usage = usageObj(inTok, outTok, Math.floor(inTok * 0.6));
    const modelUsage = { [session.model]: { inputTokens: session.tokens.input, outputTokens: session.tokens.output, cacheReadInputTokens: session.tokens.cached, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: session.costUsd, contextWindow: CONTEXT_WINDOW, maxOutputTokens: 32000 } };
    const common = { duration_ms: dur, duration_api_ms: Math.floor(dur * 0.8), num_turns: 1, session_id: session.id, total_cost_usd: session.costUsd, usage, modelUsage, permission_denials: [], fast_mode_state: "off", uuid: randomUUID(), ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}) };
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
    } else {
      write({ type: "result", subtype: "success", is_error: false, api_error_status: null, result: rt.lastText(), stop_reason: "end_turn", terminal_reason: "completed", ...common });
    }
    persist();
  }

  // serial turn queue (the real CLI queues user messages that arrive mid-turn)
  const turnQueue = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (turnQueue.length) {
        try {
          await runTurn(turnQueue.shift());
        } catch (e) {
          log("crash", { error: String(e?.stack ?? e) });
        }
      }
    } finally {
      draining = false;
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
        return ok({ mcpServers: [] });
      case "mcp_set_servers": // T3 registers its own `t3-code` orchestration MCP server on every session; the mock "connects" and never calls it
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
        turnQueue.push({ raw, uuid: typeof msg.uuid === "string" ? msg.uuid : undefined });
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
  makeLog(env.MOCK_LOG, { agent: "claude-print" })("textgen", { reply: obj, keys });
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
