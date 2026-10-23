import { S } from "../lib/ir.mjs";

// Mobile S41: like approval-allow, but an optional start gate (args.gate) lets the driver open the thread in the
// app first, so the approval request arrives while the screen is already mounted and settled.
export default {
  id: "live-approval",
  title: "Live approval request",
  steps: (ctx) => [
    ...(ctx.args.gate ? [S.hold(ctx.args.gate)] : []),
    S.say("I need to write a notes file. This needs your approval.\n\n"),
    S.permission({
      action: { fsWrite: { path: "NOTES.md", content: "# Notes\n\nCreated by the mock agent after approval.\n" } },
      onAllow: [S.sh("cat NOTES.md"), S.say("\nApproved: `NOTES.md` was written.")],
      onReject: [S.say("\nUnderstood, I will not write `NOTES.md`.")],
    }),
  ],
};
