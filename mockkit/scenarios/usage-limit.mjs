import { S } from "../lib/ir.mjs";

// Streams a bit, then fails with a usage-limit error. Codex adapter: codexErrorInfo "usageLimitExceeded" + account/rateLimits/updated
// -> T3 "Usage limit reached" / Limited state. ACP adapter: plain failing turn.
export default {
  id: "usage-limit",
  title: "Usage limit reached",
  steps: () => [
    S.say("Continuing the migration...\n\n"),
    S.error("You've hit your usage limit. Upgrade to Pro or try again later.", -32603, "usage_limit"),
  ],
};
