// S14 usage limit: grok-driver instance backed by the UPSTREAM acp-mock-agent.ts with T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG=1.
// Whether T3 renders the "Usage limit reached" recovery UI for this frame is asserted, not assumed: the driver fails if it is not seen.
import { composerEditor, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";
import { pickInstance, seedUpstreamGrok } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  seedUpstreamGrok(env, "grok_usage", "Upstream (usage limit)", { T3_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG: "1" });
  await startSession(page, env);
  await page.waitForTimeout(8000); // hot reload + probes
  await pickInstance(page, "Upstream (usage limit)", { shot });
  await composerEditor(page).click();
  await sendPrompt(page, "Please keep working on the migration.");
  await page.waitForTimeout(10_000);
  await shot("after-send");
  await dumpPage(page, "s14 after send");
  const banner = page.getByText(/Usage limit reached|usage limit|rate limit/i).first();
  const seen = await banner.isVisible().catch(() => false);
  console.log(`usage-limit UI visible: ${seen}`);
  if (!seen) throw new Error("no usage-limit UI observed (frame mapping not rendered)");
  await shot("usage-limit-banner");
}
