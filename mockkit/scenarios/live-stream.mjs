import { S } from "../lib/ir.mjs";

// Visible incremental stream for mobile (S40): eight numbered steps, ~2 s each, with a gate after step 5
// (hold name from args, default "live") so a capture can pin a genuinely mid-turn state before releasing it.
const STEPS = [
  "reading the project layout",
  "checking the package manifest",
  "planning the smallest change",
  "drafting the new helper",
  "wiring it into the entry point",
  "running the type checker",
  "reviewing the final diff",
  "writing the summary",
];

export default {
  id: "live-stream",
  title: "Live streaming turn",
  steps: (ctx) => {
    const line = (i) => S.say(`Step ${i + 1} of ${STEPS.length}: ${STEPS[i]}\n\n`, { chunk: 2, paceMs: 450 });
    return [
      ...[0, 1, 2, 3, 4].map(line),
      S.hold(ctx.args.hold ?? "live"),
      ...[5, 6, 7].map(line),
      S.say("Live stream complete.", { chunk: 2, paceMs: 200 }),
    ];
  },
};
