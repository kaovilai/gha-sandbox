import { S } from "../lib/ir.mjs";

// Gated by the UI click: the turn blocks on session/request_permission until the user answers.
export default {
  id: "approval-allow",
  title: "Approval request",
  steps: () => [
    S.say("I need to write a notes file. This needs your approval.\n\n"),
    S.permission({
      action: { fsWrite: { path: "NOTES.md", content: "# Notes\n\nCreated by the mock agent after approval.\n" } },
      onAllow: [S.sh("cat NOTES.md"), S.say("\nApproved: `NOTES.md` was written.")],
      onReject: [S.say("\nUnderstood, I will not write `NOTES.md`.")],
    }),
  ],
};
