import { S } from "../lib/ir.mjs";

// Background Bash (Claude Bash run_in_background:true + background_tasks_changed + task_started; after the turn the CLI reports
// task_notification and wakes itself). Args: until=<gate> holds the completion report; mode=stop starts a long task, reads its output
// (TaskOutput) and kills it (TaskStop); mode=output reads its output while it runs and lets it finish. Default: start + finish.
// Other adapters (no background-task protocol, or ACP's own variant) run the command in the foreground / ignore bgControl.
export default {
  id: "background-bash",
  title: "Background Bash",
  steps: (ctx) => {
    const mode = ctx.args.mode;
    if (mode === "stop") {
      return [
        S.say("Starting the watcher in the background.\n\n"),
        S.bgTask("echo watcher started; sleep 600", { description: "Run the file watcher", kind: "command" }),
        S.sleep(800),
        S.bgControl("output"),
        S.say("The watcher printed its start line. Stopping it now.\n\n"),
        S.bgControl("stop"),
        S.say("The watcher was stopped."),
      ];
    }
    if (mode === "output") {
      return [
        S.say("Starting the build in the background.\n\n"),
        S.bgTask("echo compiling...; sleep 3; echo build finished", { description: "Run the build", kind: "command", until: ctx.args.until }),
        S.sleep(1200),
        S.bgControl("output"),
        S.say("The build is still running; I will be told when it finishes."),
      ];
    }
    return [
      S.say("Starting the build in the background.\n\n"),
      S.bgTask("echo compiling...; sleep 2; echo build finished", { description: "Run the build", kind: "command", until: ctx.args.until }),
      S.say("The build is running in the background."),
    ];
  },
};
