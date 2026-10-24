import { S } from "../lib/ir.mjs";

// Background terminal (Codex): a command that outlives its turn. The agent starts the dev server and ends the turn while the
// commandExecution item is still running; T3 keeps the settled turn alive, and when the command exits it re-prompts the agent
// (a continuation message "Background command completed (exit N): <command> ... Output tail: ..." answered by `bg-wake`).
//   until=<gate>  the completion is only reported once the hold gate is released (driver pins the running state first)
//   close=1       thread/closed variant: the terminal is killed WITHOUT a completion and T3 marks the item interrupted
// Adapters without a background-task protocol (Claude) run the command as a plain foreground shell step.
export default {
  id: "bg-terminal",
  title: "Background terminal",
  steps: (ctx) => {
    const close = ctx.args.close === "1";
    const cmd = close ? "echo 'worker ready, polling queue'; sleep 600" : "echo 'dev server listening on http://localhost:5173'; sleep 3; echo 'dev server stopped (idle timeout)'";
    return [
      S.say(close ? "I'll start a queue worker in a background terminal and keep going.\n\n" : "I'll start the dev server in a background terminal and keep going.\n\n"),
      S.bgTask(cmd, { description: close ? "Queue worker" : "Dev server", until: ctx.args.until, close }),
      S.say(close ? "\nThe worker is running in the background." : "\nThe dev server is running in the background. I'll check on it when it finishes."),
    ];
  },
};
