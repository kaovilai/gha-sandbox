import { S } from "../lib/ir.mjs";

// Raw reasoning (Codex item/reasoning/textDelta -> reasoning `content`) after a summarized reasoning block, then the answer.
export default {
  id: "raw-reasoning",
  title: "Raw reasoning",
  steps: () => [
    S.think("Summary: weigh a recursive walk against an iterative one.\n"),
    S.think("RAW> The input depth is unbounded, so recursion risks a stack overflow. An explicit stack keeps memory flat. Going iterative.\n", { raw: true }),
    S.say("I'll walk the tree iteratively with an explicit stack so deep inputs cannot overflow the call stack."),
  ],
};
