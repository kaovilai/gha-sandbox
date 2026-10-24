import { S } from "../lib/ir.mjs";

// Lifecycle hooks around a tool call (Claude hook_started / hook_response system frames). T3's Claude adapter has no handler for
// these frames: they must not break the turn, and nothing about them is rendered (the driver asserts exactly that).
export default {
  id: "hooks",
  title: "Hooks",
  steps: () => [
    S.hook("SessionStart", { name: "SessionStart:startup" }),
    S.hook("UserPromptSubmit", { output: "prompt checked by mock hook" }),
    S.say("Running a command with hooks attached.\n\n"),
    S.hook("PreToolUse", { name: "PreToolUse:Bash", output: "pre-tool hook ok" }),
    S.sh("echo hooked"),
    S.hook("PostToolUse", { name: "PostToolUse:Bash", output: "post-tool hook ok" }),
    S.say("Done: the command ran with PreToolUse and PostToolUse hooks."),
  ],
};
