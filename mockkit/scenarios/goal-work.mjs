import { S } from "../lib/ir.mjs";

// Thread goal (Codex thread/goal/*): used for the turn started by `/goal <objective>`. The goal is active while the turn
// runs (T3 shows "Pursuing goal"); `hold=<name>` keeps it in that state, then the step `goal` marks it complete.
// Other adapters ignore the goal op and just run the turn.
export default {
  id: "goal-work",
  title: "Pursue a goal",
  steps: (ctx) => [
    S.say("Starting on the goal. First I'll inspect the helper.\n\n"),
    S.read("src/greeting.ts"),
    ...(ctx.args.hold ? [S.hold(ctx.args.hold)] : []),
    S.say("\nThe helper already returns a greeting, so the goal is met."),
    S.goal({ status: "complete", tokensUsed: 4200 }),
  ],
};
