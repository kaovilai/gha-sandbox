import { S } from "../lib/ir.mjs";

// Streams a bit, then holds until $MOCK_CONTROL_DIR/release/<hold> exists (default hold name: rec).
export default {
  id: "slow",
  title: "Long-running turn",
  steps: (ctx) => [
    S.say("Working on a long task. Streaming partial output while the run is in progress...\n\n", { chunk: 3, paceMs: 80 }),
    S.hold(ctx.args.hold ?? "rec"),
    S.say("Finished the long task."),
  ],
};
