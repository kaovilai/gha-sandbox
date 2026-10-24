// S69 WebSearch + WebFetch (Claude tools): `WebSearch {query}` with a structured result {query, results:[{content:[{title,url}]}], durationSeconds}
// and `WebFetch {url, prompt}` with the fetched page. T3 maps both to `web_search` turn items (patterns, result links, fetched snippet).
import { ask, bodyText, dumpPage, expandRows, expandWork, expectText, providerOf, startSession } from "../lib/ui.mjs";
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
  for (const row of await page.getByText(/Searched the web|Fetched|Web search|Searching/).all()) await row.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const info = await dumpPage(page, "s69 web rows");
  await finding("web rows (query, result titles, fetched page)", () => `query=${/vite build\.outDir default/i.test(info.text)} link1=${/Build Options \| Vite/.test(info.text)} link2=${/Configuring Vite/.test(info.text)} url=${/vite\.dev\/config\/build-options/.test(info.text)} snippet=${/Specify the output directory/.test(info.text)}`);
  await finding("row labels", async () => JSON.stringify([...(await bodyText(page)).matchAll(/(Searched[^\n]*|Fetched[^\n]*|Web search[^\n]*)/g)].map((m) => m[1].slice(0, 80))));
  await shot("work-log");
}
