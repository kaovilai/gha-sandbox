// Preset: all drivers.
process.env.SCENARIOS ||= "s03-markdown-stream,s06-edit-file-diff,s08-approval-allow,s13-error-turn,s04-reasoning-then-answer,s05-tool-read-search,s07-shell-command-output,s10-user-question,s15-interrupt-cancel,s17-multi-turn-context";
await import("./scenario.mjs");
