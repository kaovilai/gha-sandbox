// Smoke scenario: load app, screenshot. Copy + edit per PR.
import { run } from "../lib.mjs";

await run(async ({ page, shot }) => {
  await page.waitForTimeout(1500);
  await shot("home");
});
