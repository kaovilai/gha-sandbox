#!/usr/bin/env node
// Entry: zero-dep mock ACP agent over stdio. Env: MOCK_LOG, MOCK_PACE, MOCK_SEED, MOCK_DEFAULT_SCENARIO,
// MOCK_CONTROL_DIR, MOCK_HOLD_TIMEOUT_MS.
import { serveAcp } from "../adapters/acp.mjs";

process.on("SIGTERM", () => process.exit(0));
await serveAcp();
process.exit(0);
