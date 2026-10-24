// S69 WebSearch + WebFetch (Claude tools): `WebSearch {query}` with a structured result {query, results:[{content:[{title,url}]}], durationSeconds}
// and `WebFetch {url, prompt}` with the fetched page. T3 maps both to `web_search` turn items (patterns, result links, fetched snippet).
import { ask, bodyText, dumpPage, expandRows, expandWork, expectBody, expectText, providerOf, startSession } from "../lib/ui.mjs";
import { finding } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s69 is Claude-specific (WebSearch/WebFetch tools); skipped for other providers");
  await startSession(page, env);
  await ask(page, env, "web-fetch", "What is the default build.outDir in Vite?");
  await expectText(page, /According to the fetched Vite docs/, "final answer after search + fetch", 60_000);
  await page.waitForTimeout(1500);
  await shot("answer");
  await expandWork(page);
  await expandRows(page, { type: "web" });
  // observed: a "Searched the web N times" group; its two child rows (query, fetched URL) are collapsed chevron rows
  await expectBody(page, /Searched the web 2 times/, "WebSearch + WebFetch are grouped as web_search rows", 10_000);
  await page.getByText(/^Searched the web 2 times/).first().click().catch(() => {});
  await page.waitForTimeout(800);
  await expectBody(page, /vite build\.outDir default/, "WebSearch row shows the query", 10_000);
  await expectBody(page, /vite\.dev\/config\/build-options/, "WebFetch row shows the fetched URL", 10_000);
  for (const re of [/^vite build\.outDir default$/, /^https:\/\/vite\.dev\/config\/build-options\.html$/]) await page.getByText(re).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const info = await dumpPage(page, "s69 web rows");
  // observed: expanded search row lists the result titles as links; the fetch row shows the WebFetch result JSON ({bytes, code, result, url})
  await expectBody(page, /Build Options \| Vite/, "WebSearch result link 1", 10_000);
  await expectBody(page, /Configuring Vite/, "WebSearch result link 2", 10_000);
  await expectBody(page, /Specify the output directory/, "WebFetch result text", 10_000);
  await finding("row labels", async () => JSON.stringify([...(await bodyText(page)).matchAll(/(Searched[^\n]*|Fetched[^\n]*|Web search[^\n]*)/g)].map((m) => m[1].slice(0, 80))));
  await shot("work-log");
}
