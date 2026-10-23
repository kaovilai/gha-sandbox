// S03 markdown-stream: send "[mock:markdown-stream] hi", capture mid-stream and finished (table, code, copy).
// Mock script: mockkit/scenarios/markdown-stream.mjs.
import { dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await shot("ready");
  await sendPrompt(page, "[mock:markdown-stream] hi");
  await page.getByText("Streaming markdown demo").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await shot("streaming");
  await page.getByText(/end of the/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await shot("done");
  await dumpPage(page, "s03 done");
  const table = page.locator("table").first();
  if (await table.isVisible().catch(() => false)) {
    await table.scrollIntoViewIfNeeded();
    await shot("table");
  }
  const code = page.locator("pre").first();
  if (await code.isVisible().catch(() => false)) {
    await code.hover();
    await code.scrollIntoViewIfNeeded();
    await shot("code");
  }
}
