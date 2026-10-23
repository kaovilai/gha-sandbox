import { S } from "../lib/ir.mjs";

// Shell approval the user declines: nothing runs, the agent acknowledges the rejection.
export default {
  id: "approval-deny",
  title: "Declined approval",
  steps: () => [
    S.say("I want to clean the build output before rebuilding. This needs your approval.\n\n"),
    S.permission({
      action: { sh: { cmd: "rm -rf dist && echo cleaned dist" } },
      onAllow: [S.say("\nCleaned `dist`.")],
      onReject: [S.say("\nUnderstood, I will leave `dist` untouched and rebuild in place instead.")],
    }),
  ],
};
