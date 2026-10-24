// S63 hooks (Claude): hook_started / hook_response system frames around a Bash call (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse).
// T3's ClaudeAdapterV2 has no handler for them (grep hook_ in apps/server/src finds only test fixtures): the turn must complete normally and
// NOTHING about the hooks is rendered. The driver proves both: the Bash row + final text are there, and no hook text leaks into the UI.
import { ask, dumpPage, expandRows, expandWork, expectNoText, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s63 is Claude-specific (hook system frames); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "hooks", "Run a command that has hooks.");
  await expectText(page, /Done: the command ran with PreToolUse and PostToolUse hooks\./, "final answer of the turn with hooks", 60_000);
  await page.waitForTimeout(1500);
  await expandWork(page);
  await expandRows(page, { type: "command" });
  await page.waitForTimeout(800);
  const info = await dumpPage(page, "s63 hooks turn");
  await expectNoText(page, /hook_started|hook_response|pre-tool hook ok|post-tool hook ok|prompt checked by mock hook|SessionStart:startup/, "hook frames are not rendered by T3");
  await finding("Bash row output echoed", () => `hooked=${/hooked/.test(info.text)}`);
  console.log("FINDING T3 does not render Claude hook frames (hook_started/hook_response): confirmed absent from the DOM; the turn is unaffected");
  await shot("hooks-turn");
}
