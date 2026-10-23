// S33 command palette tour: Ctrl+K command list, filter, "Go to file" (file search), "Search project contents" (grep).
// Each phase asserts its own content: the action list, the filter narrowing it, a file hit, a content hit with the matching line.
import { bodyText, dumpPage, expectBody, expectNoText, expectVisible, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+K");
  const input = page.locator("input:visible").last();
  await must(page, input, "command palette input");
  await page.waitForTimeout(900);
  await expectVisible(page, page.getByPlaceholder(/Search commands, projects, and threads/), "palette input with its placeholder");
  for (const a of [/New thread in/, /Go to file/, /Search project contents/, /Add project/]) await expectBody(page, a, `palette action ${a}`);
  await shot("palette-open");
  await dumpPage(page, "s33 palette open");

  await page.keyboard.type("thread", { delay: 40 });
  await page.waitForTimeout(900);
  await expectBody(page, /New thread/, "filter 'thread' keeps the New thread actions");
  await expectNoText(page, /Search project contents/, "filter 'thread' still lists unrelated 'Search project contents'");
  await shot("palette-filtered");

  await page.keyboard.press("Control+A");
  await page.keyboard.type("go to file", { delay: 30 });
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter"); // keepOpen: switches to file search
  await page.waitForTimeout(900);
  await page.keyboard.type("greet", { delay: 60 });
  await page.waitForTimeout(1800);
  await expectBody(page, /src\/greeting\.ts/, "file search hit src/greeting.ts for 'greet'");
  await expectBody(page, /Open file/, "file-search footer hint 'Open file'");
  await shot("palette-go-to-file");
  await dumpPage(page, "s33 file search");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+K");
  await must(page, page.locator("input:visible").last(), "palette reopened");
  await page.keyboard.type("search project", { delay: 30 });
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  await page.keyboard.type("Hello", { delay: 60 });
  await page.waitForTimeout(2500);
  await expectBody(page, /\d+ results? in \d+ files?/, "content search result summary");
  await expectBody(page, /return\s+`Hello, \$\{name\}/, "content search shows the matching line of greeting.ts");
  await shot("palette-content-search");
  const t = await bodyText(page);
  console.log(`FINDING content-search summary: ${t.match(/\d+ results? in \d+ files?/)?.[0]}`);
  await dumpPage(page, "s33 content search");
}
