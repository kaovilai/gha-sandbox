import { S } from "../lib/ir.mjs";

// Subagents (Codex collabAgentToolCall spawnAgent + child thread turns): two workers run one after the other on their own
// threads. Arg `hold=<name>` blocks the first worker mid-run so the "running" state can be captured.
// Other adapters degrade each spawn to one tool call carrying the worker's text.
export default {
  id: "subagent-spawn",
  title: "Spawn subagents",
  steps: (ctx) => [
    S.say("I'll split this up: one worker maps the code, another checks the build script.\n\n"),
    S.subagent({
      name: "explorer",
      prompt: "Find where greet() is defined and used under src/.",
      steps: [
        S.say("Looking through the source tree.\n\n"),
        S.read("src/greeting.ts"),
        ...(ctx.args.hold ? [S.hold(ctx.args.hold)] : []),
        S.say("`greet()` is defined in `src/greeting.ts` and is not called anywhere else."),
      ],
    }),
    S.subagent({
      name: "builder",
      prompt: "Check the build script in package.json.",
      steps: [S.sh("grep -n build package.json"), S.say("The `build` script runs `tsc`.")],
    }),
    S.say("\nBoth workers finished: `greet()` is unused elsewhere and the build runs `tsc`."),
  ],
};
