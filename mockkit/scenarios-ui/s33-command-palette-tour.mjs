// S33 command palette tour: Ctrl+K command list, filter, "Go to file" (file search), "Search project contents" (grep).
import { dumpPage, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+K");
  const input = page.locator("input:visible").last();
  await must(page, input, "command palette input");
  await page.waitForTimeout(900);
  await shot("palette-open");
  await dumpPage(page, "s33 palette open");

  await page.keyboard.type("thread", { delay: 40 });
  await page.waitForTimeout(900);
  await shot("palette-filtered");

  await page.keyboard.press("Control+A");
  await page.keyboard.type("go to file", { delay: 30 });
  await page.waitForTimeout(700);
  await page.keyboard.press("Enter"); // keepOpen: switches to file search
  await page.waitForTimeout(900);
  await page.keyboard.type("greet", { delay: 60 });
  await page.waitForTimeout(1800);
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
  await shot("palette-content-search");
  await dumpPage(page, "s33 content search");
}
