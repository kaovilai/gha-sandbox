// static profile scenario: open the page, full-page screenshot. Copy + edit per repro.
import { run } from "../../lib.mjs";

await run(async ({ page, shot }) => {
  await page.waitForTimeout(500);
  await shot("home", { fullPage: true });
});
