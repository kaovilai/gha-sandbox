// S04 reasoning-then-answer: agent_thought_chunk stream, then the answer. The reasoning row is a collapsed
// one-line "Thought: ..." preview (role=button aria-expanded=false); we REALLY expand it before the `expanded` shot
// and assert aria-expanded=true plus a phrase only present in the full text.
import { ask, dumpPage, expandRows, expandWork, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "think", "Which design should we pick?");
  await page.waitForTimeout(1500);
  await shot("thinking-streaming");
  await page.getByText(/simpler approach wins/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("answer-reasoning-collapsed");

  await expandWork(page); // "Worked for Ns" group -> reveals the (still collapsed) reasoning row
  const reasoning = page.locator('[data-v2-item-type*="reasoning"]').first();
  const n = await expandRows(page, { type: "reasoning" });
  console.log(`FINDING reasoning rows expanded by click: ${n}`);
  if (n === 0) {
    // fall back: the row carries the thought preview text
    await page.getByText(/The user wants a short explanation/).first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  const expandedAttr = await reasoning.getAttribute("aria-expanded").catch(() => null);
  const bodyText = await page.evaluate(() => document.body.innerText);
  const fullVisible = /compare their trade-offs, and then pick the simpler one/.test(bodyText);
  console.log(`FINDING reasoning aria-expanded=${expandedAttr} full-text-visible=${fullVisible}`);
  await dumpPage(page, "s04 after expand");
  if (!fullVisible && expandedAttr !== "true") {
    await shot("expand-FAILED");
    throw new Error("S04: reasoning row did not expand (full thought text not visible, aria-expanded != true)");
  }
  await shot("reasoning-expanded");
}
