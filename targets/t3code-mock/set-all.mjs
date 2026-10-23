// Preset: all drivers.
process.env.SCENARIOS ||= "s03-markdown-stream,s04-reasoning-then-answer,s05-tool-read-search,s06-edit-file-diff,s07-shell-command-output,s08-approval-allow,s10-user-question,s11-plan-todo,s13-error-turn,s15-interrupt-cancel,s17-multi-turn-context";
await import("./scenario.mjs");
