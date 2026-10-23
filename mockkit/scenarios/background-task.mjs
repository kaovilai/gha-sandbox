import { S } from "../lib/ir.mjs";

// A background task (xAI background-task protocol, ACP/Grok adapter). Default: a PERSISTENT Monitor ("Watch the dev server"):
// the turn ends normally while the task stays pending, which shows the composer's background-work banner (task label + Stop).
// `kind=command` = a background shell command instead (T3 holds the root turn open until it ends).
// The task is reported finished when the process has exited AND (if given) the hold gate `until` is released, so a driver can
// pin the running state, then release it (mockctl release <name>) and see the banner clear.
export default {
  id: "background-task",
  title: "Background task",
  steps: (ctx) => {
    const command = ctx.args.kind === "command";
    return [
      S.say(command ? "I'll start the dev server in the background and keep going.\n\n" : "I'll watch the dev server in the background and keep going.\n\n"),
      S.bgTask(ctx.args.cmd ?? "echo 'dev server listening on http://localhost:5173'", {
        description: command ? "Run the dev server" : "Watch the dev server",
        kind: command ? "command" : "monitor",
        persistent: !command,
        until: ctx.args.until,
      }),
      S.say("\nThe dev server is running in the background. I'll check on it when it finishes."),
    ];
  },
};
