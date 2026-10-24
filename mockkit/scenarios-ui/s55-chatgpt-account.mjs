// S55 chatgpt-account (Codex): MOCK_CODEX_ACCOUNT=chatgpt (+ MOCK_CODEX_PLAN=pro, one reset credit). account/read returns a
// ChatGPT subscription account, so Settings > Providers shows "ChatGPT Pro 20x Subscription" + the account email, and
// account/rateLimits/read feeds the usage windows (5h / weekly) and reset credits: shown by the composer's `/usage-limits` command.
// Codex only (the Grok flavor has no ChatGPT account).
import { bodyText, composerEditor, expectBody, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { gotoPath, must } from "../lib/ui-extra.mjs";

export const meta = { env: { MOCK_CODEX_ACCOUNT: "chatgpt", MOCK_CODEX_PLAN: "pro", MOCK_CODEX_RESET_CREDITS: "1" } };

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await sendPrompt(page, "Hello from a ChatGPT-subscription account");
  await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("thread");
  // composer slash command, answered locally from the provider's usage snapshot
  await composerEditor(page).click();
  await composerEditor(page).pressSequentially("/usage-limits", { delay: 15 });
  await page.waitForTimeout(800);
  await shot("slash-menu");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  if (/\/usage-limits/.test((await composerEditor(page).innerText().catch(() => "")) ?? "")) await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const lim = await dumpPage(page, "s55 usage limits");
  console.log(`FINDING usage-limits banner: title=${/Usage limits/.test(lim.text)} session=${/Session/.test(lim.text)} weekly=${/Weekly/.test(lim.text)} reset-credit=${/credit/i.test(lim.text)}`);
  await shot("usage-limits");
  // redeem the banked reset credit: account/rateLimitResetCredit/consume -> outcome "reset", the banner refreshes
  const useReset = page.getByRole("button", { name: /Use reset/ }).first();
  if (await useReset.isVisible().catch(() => false)) {
    await useReset.click();
    await page.waitForTimeout(1500);
    await shot("use-reset-confirm");
    await page.getByRole("button", { name: /^Use credit$/ }).click().catch(() => console.log("FINDING: no 'Use credit' confirm button"));
    // T3 redeems on a SEPARATE app-server process and re-probes account/rateLimits/read on another: the mock persists the account state
    // (control dir codex-account.json) so the refreshed snapshot shows cleared windows + one credit fewer. Poll for the bars to refresh.
    const t0 = Date.now();
    while (Date.now() - t0 < 25_000 && /Use reset/.test(await bodyText(page))) await page.waitForTimeout(500);
    await page.waitForTimeout(1500);
    const after = await dumpPage(page, "s55 after Use reset");
    console.log(`FINDING after Use reset (${Date.now() - t0}ms): credit-text=${JSON.stringify(after.text.match(/[^\n]*reset credit[^\n]*/i)?.[0] ?? null)} useResetStillThere=${/Use reset/.test(after.text)} bars=${JSON.stringify(after.text.match(/(Session|Weekly)[^\n]*\n?[^\n]*left/g) ?? null)} sessionLeft=${JSON.stringify(after.text.match(/Session[\s\S]{0,40}?(\d+)%/)?.[1] ?? null)}`);
    // verified (run 40045786074): both bars read "100% left" and the credit line "No reset credits banked" once the account state is shared across processes
    await expectBody(page, /Session\s*\n?\s*100% left/, "Session bar refreshed to 100% left after Use reset", 10_000);
    await expectBody(page, /No reset credits banked/, "credit count refreshed (none left)", 10_000);
    await shot("usage-limits-after-reset");
  }
  await gotoPath(page, "/settings/providers");
  await must(page, page.getByText(/ChatGPT Pro/), "ChatGPT plan label on the Codex provider card", 30_000);
  await page.waitForTimeout(3000);
  const prov = await dumpPage(page, "s55 providers");
  console.log(`FINDING provider card: plan=${/ChatGPT Pro \d* ?Subscription/.test(prov.text)} email=${/mock@example\.com/.test(prov.text)} usage=${/Weekly|Session/.test(prov.text)}`);
  await shot("provider-card");
}
