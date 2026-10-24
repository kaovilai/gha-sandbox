// S70 provider retry + notices (Claude): `system api_retry` frames (attempt/max_retries/retry_delay_ms, 529 server_error) -> T3 retry row that clears when
// output resumes (pinned with a hold gate); then a system `informational` warning -> T3 system_notice row.
import { ask, bodyText, dumpPage, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";
import { release, waitReached } from "../ctl/mockctl.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s70 is Claude-specific (api_retry / informational frames); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "provider-retry", "Answer with a flaky connection.", { hold: "retry70" });
  await waitReached("retry70", 60_000, env);
  await page.waitForTimeout(2500);
  const retrying = await dumpPage(page, "s70 retrying");
  await expectBody(page, /Retrying provider \(2\/5\)/, "api_retry frame renders a retry row with the attempt counter", 10_000);
  await shot("retrying");
  release("retry70", env);
  await expectText(page, /Connection restored\. Here is the answer after two retries\./, "answer after the retries", 60_000);
  await page.waitForTimeout(2000);
  await shot("recovered");
  if (/Reconnecting|Retrying provider/i.test(await bodyText(page))) throw new Error("assertion failed: retry row still shown after output resumed");
  await ask(page, env, "notice", "Continue please.");
  await expectText(page, /Continuing with the fallback model\./, "assistant line after the notice", 60_000);
  await page.waitForTimeout(1500);
  const n = await dumpPage(page, "s70 notice");
  await expectBody(page, /Heads up: this mock session is running on a fallback model\./, "T3 renders the informational system notice text", 10_000);
  await expectBody(page, /fallback model/, "notice or reply mentioning the fallback model", 10_000);
  await shot("notice");
}
