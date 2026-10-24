import { S } from "../lib/ir.mjs";

// Context compaction (Claude: T3 sends the text "/compact" as a user message; the CLI answers status:compacting, compact_boundary
// {pre_tokens, post_tokens}, a synthetic summary message and a `result` with local_command:"compact" -> T3 "Compacting context" row,
// then "Context compacted" with before/after token counts, and the context meter drops). Args: hold=<gate> pins the running state,
// pre=<tokens> post=<tokens>. Other adapters degrade the op to one assistant line.
export default {
  id: "compact",
  title: "Compact context",
  steps: (ctx) => [
    S.compact({
      trigger: "manual",
      hold: ctx.args.hold,
      ...(ctx.args.pre ? { pre: Number(ctx.args.pre) } : {}),
      ...(ctx.args.post ? { post: Number(ctx.args.post) } : {}),
      summary: "The user asked about greet() and a README update; the assistant answered and edited README.md.",
    }),
  ],
};
