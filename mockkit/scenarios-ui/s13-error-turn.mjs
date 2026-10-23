// S13 error-turn: the prompt fails with a JSON-RPC error; UI shows error banner, Provider error row, Failed pill.
import { ask, dumpPage, expectText, expectVisible, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "error-turn", "Run the task.");
  await page.getByText(/mock failure|invalid_request_error|Bad Request/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  // the error is surfaced three ways: the partial reply before it, a "Provider error" row with the message, and the Failed thread pill
  await expectText(page, /Starting the task\.\.\./, "assistant text streamed before the failure");
  await expectText(page, /^Provider error$/, "'Provider error' timeline row");
  await expectText(page, /invalid_request_error: mock failure injected by the error-turn scenario/, "provider error message text");
  await expectVisible(page, page.getByText(/^Failed$/), "'Failed' status pill on the thread");
  await shot("error");
  await dumpPage(page, "s13 error");
}
