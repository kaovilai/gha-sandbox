// S13 error-turn: the prompt fails with a JSON-RPC error; UI shows error banner, Provider error row, Failed pill.
import { ask, dumpPage, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "error-turn", "Run the task.");
  await page.getByText(/mock failure|invalid_request_error|Bad Request/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot("error");
  await dumpPage(page, "s13 error");
}
