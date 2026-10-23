// S13 error-turn: the prompt fails with a JSON-RPC error; the UI should show an error banner / failed state.
import { addProject, dumpPage, newMockThread, sendPrompt } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await page.waitForTimeout(2500);
  const project = await addProject(page, env.MOCKKIT_WS, { shot });
  await newMockThread(page, { project, shot });
  await sendPrompt(page, "[mock:error-turn] run the task");
  await page.getByText(/mock failure|invalid_request_error|Bad Request/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("error");
  await dumpPage(page, "s13 error");
}
