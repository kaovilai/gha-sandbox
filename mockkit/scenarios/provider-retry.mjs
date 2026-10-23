import { S } from "../lib/ir.mjs";

// Transient provider failure (Codex `error` with willRetry:true): T3 shows a "Reconnecting" retry row that clears when
// output resumes. `hold=<name>` keeps the retry visible. Other adapters ignore the retry op.
export default {
  id: "provider-retry",
  title: "Provider retry",
  steps: (ctx) => [
    S.say("Calling the model.\n\n"),
    S.retry("Reconnecting... 1/5", 1, 5),
    S.sleep(300),
    S.retry("Reconnecting... 2/5", 2, 5),
    ...(ctx.args.hold ? [S.hold(ctx.args.hold)] : []),
    S.say("Connection restored. Here is the answer after two retries."),
  ],
};
