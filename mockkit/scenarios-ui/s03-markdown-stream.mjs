// S03 markdown-stream: send "[mock:markdown-stream] hi", wait for the stream to finish, capture rendered
// heading/list/table/code. Mock script: mockkit/scenarios/markdown-stream.mjs.
import { dumpPage, sendPrompt } from "../lib/ui.mjs";

export default async function ({ page, shot }) {
  await page.waitForTimeout(3000);
  await shot("before");
  await dumpPage(page, "s03 start");
  await sendPrompt(page, "[mock:markdown-stream] hi");
  await page.waitForTimeout(2500);
  await shot("streaming");
  await page.getByText("end of the markdown stream").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("done");
  await dumpPage(page, "s03 done");
}
