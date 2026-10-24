import { S } from "../lib/ir.mjs";

// Auto-compaction in the middle of a turn (trigger "auto"): the model is working, the CLI compacts, the model continues.
export default {
  id: "compact-auto",
  title: "Auto-compaction mid-turn",
  steps: (ctx) => [
    S.say("Working through the long task...\n\n"),
    S.compact({ trigger: "auto", pre: 168000, post: 4200, hold: ctx.args.hold, summary: "Long task in progress: three files were reviewed, two edits are pending." }),
    S.say("Context was compacted automatically; continuing with the remaining edits."),
  ],
};
