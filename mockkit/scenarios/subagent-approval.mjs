import { S } from "../lib/ir.mjs";

// A subagent that needs approval on its own thread: the request carries the CHILD thread/turn ids, so T3 surfaces it in the
// parent thread ("Open approval") and in the child thread. Needs Supervised mode. Other adapters degrade the spawn to one tool call
// (the child's permission is auto-allowed there).
export default {
  id: "subagent-approval",
  title: "Subagent needs approval",
  steps: () => [
    S.say("Delegating the notes file to a worker.\n\n"),
    S.subagent({
      name: "writer",
      prompt: "Write NOTES.md with the summary.",
      steps: [
        S.say("I need to write NOTES.md and that needs approval.\n\n"),
        S.permission({
          action: { fsWrite: { path: "NOTES.md", content: "# Notes\n\nWritten by the writer subagent.\n" } },
          onAllow: [S.say("\nWrote `NOTES.md`.")],
          onReject: [S.say("\nSkipped `NOTES.md`.")],
        }),
      ],
    }),
    S.say("\nThe writer subagent finished."),
  ],
};
