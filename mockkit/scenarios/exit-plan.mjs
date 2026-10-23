import { S } from "../lib/ir.mjs";

// xAI exit_plan_mode extension: the agent hands T3 a markdown plan, which renders as a ProposedPlanCard
// (T3 captures it and abandons the native approval gate, so the turn then ends).
export const PLAN_MD = `# Refactor the greeting helper

## Goals
- Make \`greet()\` friendlier
- Add a \`farewell()\` companion
- Keep the public API backwards compatible

## Steps
1. Read \`src/greeting.ts\` and find call sites
2. Rewrite \`greet()\` to trim the name and add a welcome
3. Add \`src/farewell.ts\`
4. Run the build and fix type errors

## Risks
- Callers that pass an empty string get \`Hello, world!\`
`;

export default {
  id: "exit-plan",
  title: "Proposed plan",
  steps: () => [
    S.think("The user wants a plan first, not edits. I will write the plan and hand it over for review.\n", { paceMs: 60 }),
    S.say("I looked at the helper and drafted a plan.\n\n"),
    S.exitPlan(PLAN_MD),
    S.say("The plan is ready for your review."),
  ],
};
