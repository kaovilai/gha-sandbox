import { S } from "../lib/ir.mjs";

// Subagents over the newer `subAgentActivity` protocol (started / completed items whose agentPath titles the row in T3), plus
// per-child `thread/settings/updated` (model + reasoning effort) and `model/rerouted` (the second child is rerouted mid-run).
// Arg `hold=<gate>` blocks the first child mid-run to capture the running state.
export default {
  id: "subagent-activity",
  title: "Subagent activity",
  steps: (ctx) => [
    S.say("I'll delegate two jobs to named subagents.\n\n"),
    S.subagent({
      name: "explorer",
      role: "explorer",
      path: "/root/explorer",
      prompt: "Find where greet() is defined and used under src/.",
      settings: { model: "gpt-6-luna", effort: "low" },
      steps: [
        S.say("Scanning src/ for greet().\n\n"),
        S.read("src/greeting.ts"),
        ...(ctx.args.hold ? [S.hold(ctx.args.hold)] : []),
        S.say("`greet()` lives in `src/greeting.ts`; nothing else calls it."),
      ],
    }),
    S.subagent({
      name: "builder",
      role: "worker",
      path: "/root/builder",
      prompt: "Check the build script in package.json.",
      reroute: "gpt-5.6-sol",
      steps: [S.sh("grep -n build package.json"), S.say("The `build` script runs `tsc`.")],
    }),
    S.say("\nBoth subagents reported back: greet() is unused elsewhere and the build runs tsc."),
  ],
};
