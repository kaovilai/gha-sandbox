// S14 usage limit: an acpRegistry instance running upstream acp-mock-agent.ts with T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG=1.
// Exploratory: whether T3 maps this frame to the "Usage limit reached" recovery banner is UNVERIFIED until a run shows it.
import { composerEditor, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { must, seedUpstreamAcp } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  seedUpstreamAcp(env, "acp_usage", "Upstream (usage limit)", { T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG: "1" });
  await startSession(page, env);
  await page.waitForTimeout(8000); // hot reload + probe of the upstream agent
  await page.keyboard.press("Control+Shift+M");
  await page.waitForTimeout(1200);
  const btn = page.getByRole("button", { name: /Upstream \(usage limit\)/ }).first();
  await must(page, btn, "upstream usage-limit provider in picker", 30_000);
  await btn.click();
  await page.waitForTimeout(1000);
  await shot("picker-upstream");
  await dumpPage(page, "s14 picker upstream");
  // first model row of that provider
  const rows = page.locator('[role="option"], [data-model-picker-row]');
  if (await rows.first().isVisible().catch(() => false)) await rows.first().click();
  else await page.getByText(/Upstream \(usage limit\)/).last().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  await composerEditor(page).click();
  await sendPrompt(page, "Please keep working on the migration.");
  await page.waitForTimeout(12_000);
  await shot("after-send");
  await dumpPage(page, "s14 after send");
  const banner = page.getByText(/Usage limit reached|usage limit|rate limit/i).first();
  const seen = await banner.isVisible().catch(() => false);
  console.log(`usage-limit banner visible: ${seen}`);
  if (!seen) throw new Error("no usage-limit UI observed (frame mapping UNVERIFIED)");
}
