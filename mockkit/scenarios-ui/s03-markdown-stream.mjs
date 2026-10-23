// S03 markdown-stream: send "[mock:markdown-stream] hi", wait for the stream to finish, capture rendered
// heading/list/table/code. Mock script: mockkit/scenarios/markdown-stream.mjs.
import { addProject, dumpPage, newMockThread, sendPrompt } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await page.waitForTimeout(2500);
  const project = await addProject(page, env.MOCKKIT_WS, { shot });
  await newMockThread(page, { project, shot });
  await shot("ready");
  await sendPrompt(page, "[mock:markdown-stream] hi");
  await page.waitForTimeout(3000);
  await shot("streaming");
  await page.getByText(/end of the/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2000);
  await shot("done");
  await dumpPage(page, "s03 done");
  const table = page.locator("table").first();
  if (await table.isVisible().catch(() => false)) {
    await table.scrollIntoViewIfNeeded();
    await shot("table");
  }
  const code = page.locator("pre").first();
  if (await code.isVisible().catch(() => false)) {
    await code.scrollIntoViewIfNeeded();
    await shot("code");
  }
}
