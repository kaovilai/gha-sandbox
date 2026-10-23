// S57 provider-retry (Codex `error` notification with willRetry:true): T3 shows a retry row ("Reconnecting ... 2/5")
// while the provider reconnects; it clears when output resumes. The turn is held at the retry state to capture it.
import { ask, dumpPage, startSession } from "../lib/ui.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "provider-retry", "Summarize the repo.", { hold: "retry" });
  await waitReached("retry", 60_000, env);
  await page.waitForTimeout(2500);
  const info = await dumpPage(page, "s57 retry state");
  console.log(`FINDING retry row: reconnecting=${/Reconnect/i.test(info.text)} attempt=${JSON.stringify(info.text.match(/\d\s*\/\s*5/)?.[0] ?? null)}`);
  await shot("retrying");
  release("retry", env);
  await page.getByText(/Connection restored/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("recovered");
}
