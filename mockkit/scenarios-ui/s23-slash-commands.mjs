// S23 slash commands + model list (Claude): the Claude CLI's `initialize` control response carries the slash commands
// (init, review, security-review, context, cost; T3 adds /compact itself). Typing "/" in the composer opens T3's command menu
// listing them; the picker lists T3's bundled Claude model catalog (Opus / Sonnet / Fable / Haiku 5.x).
import { composerEditor, dumpPage, providerOf, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") {
    console.log("FINDING: s23 is Claude-specific (slash commands from the CLI initialize response); skipped for other providers");
    return;
  }
  await startSession(page, env);
  await page.waitForTimeout(4000); // let the workspace capability probe (slash commands) land
  const ed = composerEditor(page);
  await ed.click();
  await ed.pressSequentially("/", { delay: 40 });
  await page.waitForTimeout(1200);
  await shot("slash-menu-open");
  await dumpPage(page, "s23 slash menu");
  await must(page, page.getByText(/security-review/), "mock CLI slash command /security-review in the composer menu");
  await must(page, page.getByText(/^compact$|\/compact|Compact/).first(), "/compact (T3-provided) next to the CLI commands");
  await ed.pressSequentially("rev", { delay: 40 });
  await page.waitForTimeout(800);
  await shot("slash-menu-filtered");
  await page.keyboard.press("Escape");
}
