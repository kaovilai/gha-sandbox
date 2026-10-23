// Scenario-set wrapper: workflow `scenario` input is a path, not env, so presets live in files.
process.env.SCENARIOS ||= "s00-explore,s03-markdown-stream";
await import("./scenario.mjs");
