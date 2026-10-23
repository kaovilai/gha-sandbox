// Preset: first vertical slice + the P0 drivers.
process.env.SCENARIOS ||= "s03-markdown-stream,s06-edit-file-diff,s08-approval-allow,s13-error-turn";
await import("./scenario.mjs");
