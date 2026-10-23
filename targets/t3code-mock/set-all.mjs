// Preset: the full web pack (kept for the old `-f scenario=targets/t3code-mock/set-all.mjs` dispatch).
// Prefer the sandbox.yml `scenarios` input: -f scenarios=web | s07 | s03,s17 (packs: mockkit/packs.json).
process.env.SCENARIOS ||= "web";
await import("./scenario.mjs");
