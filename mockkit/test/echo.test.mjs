import assert from "node:assert/strict";
import { test } from "node:test";
import echo from "../scenarios/echo.mjs";

const textOf = (steps) => steps.map((s) => s.say?.text ?? "").join("");

test("echo quotes a normal prompt and the previous one", () => {
  const t = textOf(echo.steps({ turn: 2, text: "Second", history: ["First"] }));
  assert.match(t, /Mock agent, turn 2\. You said: "Second"\. Your previous message was: "First"\./);
});

test("echo never quotes T3's cross-provider handoff prompt", () => {
  const text = "Context handoff (full_thread_summary): Provider context handoff. Thread: 2ccfe597-5703-4444-8008-7d28305170e3. Covered app runs: 1-1.";
  const t = textOf(echo.steps({ turn: 1, text, history: [] }));
  assert.match(t, /^Mock agent, turn 1\./);
  assert.doesNotMatch(t, /Context handoff|2ccfe597|You said/);
});
