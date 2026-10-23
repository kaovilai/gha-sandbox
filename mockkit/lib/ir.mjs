// Provider-neutral scenario IR + runner.
//
// A scenario is `{ id, title?, steps(ctx) }` where steps() returns an array (nested arrays are
// flattened) of plain step objects. Use the builders below (`S.say(...)`) or write the objects by hand.
//
//   {say:{text,chunk?,paceMs?}}          stream assistant text (chunk = words/chunk)
//   {think:{text,chunk?,paceMs?}}        stream reasoning text
//   {tool:{kind,title,input?,output?,diff?,locations?,status?,server?,name?}}   one tool call (start -> completed); server/name = MCP identity (Codex)
//   {read:{path}}                        REAL file read shown as a read tool call
//   {fsWrite:{path,content,silent?}}     REAL write in session cwd (+ edit tool call w/ diff)
//   {sh:{cmd,title?}}                    REAL `sh -c` in session cwd, stdout/stderr streamed as tool output
//   {permission:{tool,action?,onAllow?,onReject?}}   ask the user; run action+onAllow or onReject
//   {ask:{questions,then?}}              ask the user questions; then(answers) -> steps
//   {plan:{entries}}                     plan/todo list update
//   {exitPlan:{planContent}}             xAI exit_plan_mode request: T3 captures planContent into a ProposedPlanCard
//   {error:{message,code?,kind?}}        fail the turn (kind "usage_limit" = Codex Limited state)
//   {hold:{name}}                        block until $MOCK_CONTROL_DIR/release/<name> exists
//   {sleep:{ms}}                         sleep
//   Codex-flavored ops (provider-neutral: adapters without a native form degrade, see below):
//   {elicit:{server,message,appName?,persist?,onAccept,onDecline}}  MCP elicitation (Codex mcpServer/elicitation/request);
//                                        degrade: a plain permission request
//   {grant:{reason,read?,write?,network?,onAllow,onReject}}  extra-permission request (Codex item/permissions/requestApproval);
//                                        degrade: a plain permission request
//   {subagent:{name,prompt,steps,model?,result?}}   spawn an agent that runs `steps` on its own thread (Codex collabAgentToolCall);
//                                        degrade: one tool call, child text becomes its output
//   {goal:{status?,tokensUsed?,timeUsedSeconds?}}   update the thread goal set by `/goal` (Codex thread/goal/*); degrade: no-op
//   {web:{query,url?}}                   web search (Codex webSearch item); degrade: a fetch-kind tool call
//   {mcpApp:{server,name,title?,html,input?,output?}}  MCP tool call whose result is an interactive HTML app (Codex mcpToolCall +
//                                        mcpAppUi + mcpServer/resource/read); degrade: a plain tool call
//   {retry:{message,attempt,max}}        transient provider retry notice (Codex error willRetry:true); degrade: no-op
//   say takes `phase:"commentary"` (Codex agentMessage phase); ignored elsewhere.
//
// Adapters implement the `sink` (message, thought, toolStart, toolUpdate, permission, ask, plan; optional:
// exitPlan, elicit, grant, subagent, goal, web, retry).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hold as holdGate } from "./hold.mjs";
import { abortError, sleep } from "./pace.mjs";

export class ScenarioError extends Error {
  constructor(message, code = -32603, kind = undefined) {
    super(message);
    this.name = "ScenarioError";
    this.code = code;
    this.kind = kind; // optional adapter hint: "usage_limit" (Codex renders the Limited state)
  }
}

// ---- builders --------------------------------------------------------------------------------
export const S = {
  say: (text, o = {}) => ({ say: { text, ...o } }),
  think: (text, o = {}) => ({ think: { text, ...o } }),
  tool: (o) => ({ tool: o }),
  read: (path) => ({ read: { path } }),
  fsWrite: (path, content, o = {}) => ({ fsWrite: { path, content, ...o } }),
  sh: (cmd, o = {}) => ({ sh: { cmd, ...o } }),
  permission: (o) => ({ permission: o }),
  ask: (o) => ({ ask: o }),
  plan: (entries) => ({ plan: { entries } }),
  exitPlan: (planContent) => ({ exitPlan: { planContent } }),
  error: (message, code, kind) => ({ error: { message, code, kind } }),
  hold: (name) => ({ hold: { name } }),
  sleep: (ms) => ({ sleep: { ms } }),
  elicit: (o) => ({ elicit: o }),
  grant: (o) => ({ grant: o }),
  subagent: (o) => ({ subagent: o }),
  goal: (o = {}) => ({ goal: o }),
  mcpApp: (o) => ({ mcpApp: o }),
  web: (query, o = {}) => ({ web: { query, ...o } }),
  retry: (message, attempt = 1, max = 5) => ({ retry: { message, attempt, max } }),
};

export function flatten(steps) {
  return (Array.isArray(steps) ? steps : [steps]).flat(Infinity).filter(Boolean);
}

export function chunkText(text, words) {
  const toks = text.split(/(?<=\s)(?=\S)/); // keep whitespace attached to the preceding word
  const out = [];
  for (let i = 0; i < toks.length; i += words) out.push(toks.slice(i, i + words).join(""));
  return out;
}

const abs = (cwd, p) => (isAbsolute(p) ? p : resolve(cwd, p));

// ---- runner ----------------------------------------------------------------------------------
export async function runSteps(stepsIn, sink, ctx) {
  const { signal, pace, log } = ctx;
  for (const step of flatten(stepsIn)) {
    if (signal?.aborted) throw abortError();
    const type = Object.keys(step)[0];
    const a = step[type];
    log?.("step", { type, ...(type === "say" || type === "think" ? { len: a.text.length } : {}) });
    switch (type) {
      case "say":
      case "think": {
        const words = a.chunk ?? pace.chunkWords;
        const emit = type === "say" ? (t) => sink.message(t, { phase: a.phase }) : (t) => sink.thought(t);
        const chunks = chunkText(a.text, words);
        for (let i = 0; i < chunks.length; i++) {
          emit(chunks[i]);
          if (i < chunks.length - 1) await sleep(pace.chunkMs(a.paceMs), signal);
        }
        break;
      }
      case "tool": {
        const id = ctx.nextToolId();
        await sleep(pace.toolMs, signal);
        sink.toolStart({ id, kind: a.kind ?? "other", title: a.title, input: a.input, diff: a.diff, locations: a.locations, server: a.server, name: a.name, status: "in_progress" });
        await sleep(pace.toolMs, signal);
        sink.toolUpdate({ id, status: a.status ?? "completed", text: a.output, diff: a.diff, output: a.rawOutput ?? a.output });
        break;
      }
      case "read": {
        const p = abs(ctx.cwd, a.path);
        const id = ctx.nextToolId();
        await sleep(pace.toolMs, signal);
        sink.toolStart({ id, kind: "read", title: `Read ${a.path}`, input: { path: p }, locations: [{ path: p }], status: "in_progress" });
        await sleep(pace.toolMs / 2, signal);
        let text;
        let status = "completed";
        try {
          text = readFileSync(p, "utf8");
        } catch (e) {
          text = String(e.message);
          status = "failed";
        }
        sink.toolUpdate({ id, status, text, output: text });
        break;
      }
      case "fsWrite": {
        const p = abs(ctx.cwd, a.path);
        const oldText = existsSync(p) ? readFileSync(p, "utf8") : "";
        const id = ctx.nextToolId();
        const diff = { path: p, oldText, newText: a.content };
        if (!a.silent) {
          await sleep(pace.toolMs, signal);
          sink.toolStart({ id, kind: "edit", title: `${oldText ? "Edit" : "Write"} ${a.path}`, input: { file_path: p, content: a.content }, diff, locations: [{ path: p }], status: "in_progress" });
          await sleep(pace.toolMs / 2, signal);
        }
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a.content); // REAL write: git diff / checkpoint see it
        log?.("fs", { op: "write", path: p, bytes: a.content.length });
        if (!a.silent) sink.toolUpdate({ id, status: "completed", diff });
        break;
      }
      case "sh": {
        const id = ctx.nextToolId();
        await sleep(pace.toolMs, signal);
        sink.toolStart({ id, kind: "execute", title: a.title ?? a.cmd, input: { command: a.cmd }, status: "in_progress" });
        const res = await runShell(a.cmd, ctx, (acc) => sink.toolUpdate({ id, status: "in_progress", text: acc, output: { stdout: acc } }));
        // T3 reads command output/exit code from rawOutput.{stdout,exitCode}
        sink.toolUpdate({ id, status: res.code === 0 ? "completed" : "failed", text: res.output, output: { stdout: res.output, exitCode: res.code } });
        break;
      }
      case "permission": {
        const t = a.tool ?? {};
        const id = ctx.nextToolId();
        let diff = t.diff;
        const act = a.action;
        if (!diff && act?.fsWrite) {
          const p = abs(ctx.cwd, act.fsWrite.path);
          diff = { path: p, oldText: existsSync(p) ? readFileSync(p, "utf8") : "", newText: act.fsWrite.content };
        }
        const kind = t.kind ?? (act?.fsWrite ? "edit" : act?.sh ? "execute" : "other");
        const title = t.title ?? (act?.fsWrite ? `Write ${act.fsWrite.path}` : act?.sh ? act.sh.cmd : "Action");
        const input = t.input ?? (act?.fsWrite ? { file_path: abs(ctx.cwd, act.fsWrite.path), content: act.fsWrite.content } : act?.sh ? { command: act.sh.cmd } : undefined);
        await sleep(pace.toolMs, signal);
        sink.toolStart({ id, kind, title, input, diff, locations: diff ? [{ path: diff.path }] : undefined, status: "pending" });
        const decision = await sink.permission({ id, kind, title, input, diff, options: t.options });
        log?.("decision", { decision });
        if (decision === "cancel") throw abortError();
        if (decision === "reject") {
          sink.toolUpdate({ id, status: "failed", text: "Rejected by user." });
          await runSteps(a.onReject ?? [], sink, ctx);
          break;
        }
        sink.toolUpdate({ id, status: "in_progress" });
        let text = "";
        if (act?.fsWrite) {
          const p = abs(ctx.cwd, act.fsWrite.path);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, act.fsWrite.content);
          log?.("fs", { op: "write", path: p, bytes: act.fsWrite.content.length });
          text = `Wrote ${act.fsWrite.path}`;
        } else if (act?.sh) {
          const res = await runShell(act.sh.cmd, ctx, () => {});
          text = res.output;
        }
        sink.toolUpdate({ id, status: "completed", text, diff });
        await runSteps(a.onAllow ?? [], sink, ctx);
        break;
      }
      case "ask": {
        const res = await sink.ask({ questions: a.questions });
        ctx.answers = res?.answers ?? {};
        log?.("answers", { answers: ctx.answers });
        if (typeof a.then === "function") await runSteps(a.then(ctx.answers, res), sink, ctx);
        break;
      }
      case "plan":
        sink.plan(a.entries);
        break;
      case "exitPlan": {
        const res = await sink.exitPlan({ planContent: a.planContent });
        log?.("exitPlan", { outcome: res?.outcome });
        break;
      }
      case "elicit":
      case "grant": {
        // Codex-native approval variants. Sinks without them (ACP) degrade to a plain permission request.
        const native = type === "elicit" ? sink.elicit : sink.grant;
        const id = ctx.nextToolId();
        await sleep(pace.toolMs, signal);
        let decision;
        if (native) {
          decision = await native.call(sink, { id, ...a });
        } else {
          const title = type === "elicit" ? a.message : (a.reason ?? "Extra permissions");
          sink.toolStart({ id, kind: "other", title, input: { server: a.server, read: a.read, write: a.write, network: a.network }, status: "pending" });
          decision = await sink.permission({ id, kind: "other", title, input: { server: a.server } });
        }
        log?.("decision", { decision, op: type });
        if (decision === "cancel") throw abortError();
        const rejected = decision === "reject" || decision === "decline";
        if (!native) sink.toolUpdate({ id, status: rejected ? "failed" : "completed", text: rejected ? "Declined by user." : "Approved." });
        await runSteps((rejected ? (a.onDecline ?? a.onReject) : (a.onAccept ?? a.onAllow)) ?? [], sink, ctx);
        break;
      }
      case "subagent": {
        const id = ctx.nextToolId();
        await sleep(pace.toolMs, signal);
        if (sink.subagent) {
          await sink.subagent({ id, ...a }, (steps, childSink) => runSteps(steps, childSink, ctx));
          break;
        }
        // Degrade: one tool call whose output is the child's text; the child's own tool calls are not shown.
        sink.toolStart({ id, kind: "other", title: `Subagent ${a.name ?? "worker"}: ${a.prompt ?? ""}`.trim(), input: { prompt: a.prompt }, status: "in_progress" });
        let text = "";
        const quiet = { message: (t) => (text += t), thought() {}, toolStart() {}, toolUpdate() {}, plan() {}, permission: async () => "allow", ask: async () => ({ answers: {} }), exitPlan: async () => ({}) };
        await runSteps(a.steps ?? [], quiet, ctx);
        sink.toolUpdate({ id, status: "completed", text: a.result ?? text, output: a.result ?? text });
        break;
      }
      case "mcpApp": {
        const id = ctx.nextToolId();
        await sleep(pace.toolMs, signal);
        if (sink.mcpApp) {
          await sink.mcpApp({ id, ...a });
          break;
        }
        await runSteps([{ tool: { kind: "other", title: a.title ?? `${a.server}.${a.name}`, input: a.input, output: a.output ?? "(interactive MCP app, not rendered by this provider)" } }], sink, ctx);
        break;
      }
      case "goal":
        sink.goal?.(a);
        break;
      case "web": {
        if (sink.web) {
          const id = ctx.nextToolId();
          await sleep(pace.toolMs, signal);
          await sink.web({ id, ...a });
          break;
        }
        await runSteps([{ tool: { kind: "fetch", title: `Search the web: ${a.query}`, input: { query: a.query }, output: a.url ? `Result: ${a.url}` : "Search complete" } }], sink, ctx);
        break;
      }
      case "retry":
        sink.retry?.(a);
        break;
      case "error":
        throw new ScenarioError(a.message, a.code, a.kind);
      case "hold":
        await holdGate(a.name, { env: ctx.env, signal, log });
        break;
      case "sleep":
        await sleep(a.ms, signal);
        break;
      default:
        throw new Error(`unknown IR step: ${type}`);
    }
  }
}

// Process groups of running shell steps; killed on agent exit (SIGTERM handler -> process.exit) so none are orphaned.
const liveShells = new Set();
process.on("exit", () => {
  for (const pid of liveShells) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
});

function runShell(cmd, ctx, onOutput) {
  return new Promise((resolveP) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd: ctx.cwd,
      env: { ...ctx.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so abort/exit also kills grandchildren (sleep ...)
    });
    liveShells.add(child.pid);
    let acc = "";
    const onData = (d) => {
      acc += d.toString("utf8");
      onOutput(acc);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    ctx.signal?.addEventListener("abort", kill, { once: true });
    child.on("close", (code) => {
      liveShells.delete(child.pid);
      ctx.signal?.removeEventListener("abort", kill);
      resolveP({ code: code ?? 1, output: acc });
    });
    child.on("error", (e) => resolveP({ code: 127, output: acc + String(e.message) }));
  });
}
