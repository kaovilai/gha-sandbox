// Smoke scenario: load app, dismiss provider banner, screenshot. Copy + edit per PR.
import { run } from "../lib.mjs";

await run(async ({ page, shot }) => {
  await page.waitForTimeout(1500);
  // CI runner has no codex CLI -> provider-status banner; dismiss so it never
  // appears in before/after diffs. Hide as a fallback if the close button moves.
  const banner = page.getByText("Codex provider status").locator("xpath=ancestor::*[.//button][1]");
  const close = banner.getByRole("button").first();
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
  await page.addStyleTag({ content: "[role=alert]{display:none!important}" });
  await page.waitForTimeout(500);
  await shot("home");
});
