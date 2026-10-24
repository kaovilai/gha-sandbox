// S72 dynamic tool calls (Codex dynamicToolCall items): the node REPL (`node_repl.js`, titled from arguments.title) and a namespaced docs
// tool, one of which fails. T3 projects them as dynamic_tool rows in the work log. Codex flavor only (other adapters: plain tool calls).
import { ask, bodyText, dumpPage, expandRows, expandWork, expectText, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "dynamic-tool", "Measure the bundle and check the retry policy docs.");
  await expectText(page, /The bundle is 48,213 bytes, retries back off exponentially/, "assistant summary after the dynamic tools", 90_000);
  await page.waitForTimeout(1500);
  await shot("done-collapsed");
  await expandWork(page);
  await page.waitForTimeout(600);
  await expandRows(page, { type: "dynamic" });
  await expandRows(page, {});
  await page.waitForTimeout(1200);
  const info = await dumpPage(page, "s72 dynamic tools expanded");
  const t = await bodyText(page);
  console.log(`FINDING dynamic rows: replTitle=${/Check bundle size/.test(t)} replCode=${/fs\.stat/.test(t)} replOutput=${/dist\/app\.js: 48213 bytes/.test(t)} docsTool=${/acme_docs|lookup/i.test(t)} retryOutput=${/exponential backoff, at most 5/.test(t)} failedRow=${/circuit breaker/.test(t)} typeAttrs=${JSON.stringify([...new Set((info.buttons.join("\n").match(/dynamic[a-z_]*/g)) ?? [])])}`);
  await shot("expanded");
}
