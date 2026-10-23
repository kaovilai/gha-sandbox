import { S } from "../lib/ir.mjs";

// A background shell command (xAI BackgroundTaskStarted protocol, ACP/Grok adapter): the turn ends while the command is still
// "running" from T3's point of view, which shows the composer's background-work banner ("Running: <description>").
// The task is reported finished when the process has exited AND (if given) the hold gate `until` is released, so a driver can
// pin the running state, then release it (mockctl release <name>) and see the banner clear.
export default {
  id: "background-task",
  title: "Background task",
  steps: (ctx) => [
    S.say("I'll start the dev server in the background and keep going.\n\n"),
    S.bgTask(ctx.args.cmd ?? "echo 'dev server listening on http://localhost:5173'", { description: "Run the dev server", until: ctx.args.until }),
    S.say("\nThe dev server is running in the background. I'll check on it when it finishes."),
  ],
};
