// S03 markdown-stream: ask for a markdown demo (hidden-routed to markdown-stream), capture mid-stream and finished (table, code, copy).
// Mock script: mockkit/scenarios/markdown-stream.mjs.
import { ask, bodyText, dumpPage, expectLocatorText, expectNoText, expectText, expectVisible, providerOf, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await shot("ready");
  await ask(page, env, "markdown-stream", "Show me a markdown demo with a table and a code block.");
  await page.getByText("Streaming markdown demo").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  // genuinely mid-stream: the first heading is on screen, the last sentence is not
  // Claude: T3 renders assistant text per finished content block (not per delta), so the shot can legitimately look complete.
  if (/end of the/.test(await bodyText(page))) {
    if (providerOf(env) === "claude") console.log("FINDING: Claude text is rendered per finished block; streaming shot already complete");
    else throw new Error("assertion failed: the stream was already complete at the `streaming` shot");
  }
  await shot("streaming");
  await page.getByText(/end of the/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
  await shot("done");
  await dumpPage(page, "s03 done");
  // the finished reply renders real markdown, not source text
  await expectVisible(page, page.getByRole("heading", { name: "Streaming markdown demo" }), "rendered <h2> 'Streaming markdown demo'");
  await expectLocatorText(page, page.locator("table"), /Provider[\s\S]*grok \(mock\)[\s\S]*claude/, "rendered table with the provider rows");
  await expectLocatorText(page, page.locator("pre"), /export function greet/, "rendered code block with the greet() source");
  await expectVisible(page, page.getByRole("listitem").filter({ hasText: "Deterministic output, no API key" }), "rendered list item");
  await expectVisible(page, page.locator('a[href="https://example.com"]'), "rendered link to example.com");
  await expectNoText(page, /\|\s*-{3,}\s*\|/, "raw table separator row visible (markdown not rendered)");
  // Cropped stills so table and code are distinct images (clip = element box + padding, inside the viewport).
  const crop = async (loc, name) => {
    if (!(await loc.isVisible().catch(() => false))) return console.log(`FINDING no ${name} element visible`);
    await loc.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const b = await loc.boundingBox();
    const vp = page.viewportSize();
    if (!b || !vp) return;
    const pad = 24;
    const x = Math.max(0, b.x - pad);
    const y = Math.max(0, b.y - pad);
    await shot(name, { clip: { x, y, width: Math.min(vp.width - x, b.width + 2 * pad), height: Math.min(vp.height - y, b.height + 2 * pad) } });
  };
  await crop(page.locator("table").first(), "table");
  const code = page.locator("pre").first();
  await code.hover().catch(() => {});
  await crop(code, "code");
}
