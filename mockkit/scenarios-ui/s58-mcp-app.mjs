// S58 mcp-app (Codex): an MCP tool whose result is an interactive HTML app (mcpToolCall + mcpAppUi.resourceUri ui://, HTML read via
// mcpServer/resource/read). T3 snapshots the document and renders it in a sandboxed frame inside the timeline.
// Grok flavor: plain tool call (the frame is not available).
import { ask, dumpPage, expandRows, expandWork, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "mcp-app", "Show me the Linear issue board.");
  await page.getByText(/The board above shows/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3000);
  await shot("timeline");
  const frames = page.locator("iframe");
  console.log(`FINDING iframes in the page: ${await frames.count()}`);
  const inner = await Promise.all(page.frames().map((f) => f.evaluate(() => document.body?.innerText?.slice(0, 200)).catch(() => null)));
  console.log(`FINDING frame texts: ${JSON.stringify(inner.filter(Boolean))}`);
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(1500);
  await dumpPage(page, "s58 mcp app");
  await shot("expanded");
}
