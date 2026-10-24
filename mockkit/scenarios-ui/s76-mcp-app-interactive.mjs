// S76 interactive MCP app (Codex): the app's own script talks to T3 over the MCP Apps bridge. "Refresh status" -> tools/call deploy_status:
// T3 asks the provider for the server's tools (mcpServerStatus/list, real data incl. `_meta.ui.visibility`), then forwards the allowed
// call as mcpServer/tool/call and returns the result to the iframe (a fresh counter per click proves it is computed live, not canned).
// "Rotate keys" calls a tool hidden from apps (visibility ["model"]): T3 must refuse it. Codex flavor only (S58 = the static app).
import { ask, dumpPage, expectText, startSession } from "../lib/ui.mjs";

async function appFrame(page, timeout = 60_000) {
  const t0 = Date.now();
  for (;;) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      if ((await f.locator("#refresh").count().catch(() => 0)) > 0) return f;
    }
    if (Date.now() - t0 > timeout) {
      await dumpPage(page, "s76 app frame missing");
      throw new Error(`assertion failed: no iframe containing the MCP app (#refresh) after ${timeout}ms; frames=${page.frames().map((f) => f.url().slice(0, 80)).join(" | ")}`);
    }
    await page.waitForTimeout(500);
  }
}

async function waitFrameText(page, frame, selector, re, what, timeout = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const t = await frame.locator(selector).first().innerText({ timeout: 2000 }).catch(() => "");
    if (re.test(t)) return t;
    if (Date.now() - t0 > timeout) {
      await dumpPage(page, `ASSERT FAILED: ${what}`).catch(() => {});
      throw new Error(`assertion failed: expected ${what} (${selector} text was ${JSON.stringify(t)})`);
    }
    await page.waitForTimeout(300);
  }
}

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "mcp-app-interactive", "Open the deploy board.");
  await expectText(page, /The board is open: Refresh status calls the deploy_status tool/, "assistant sentence after the app opened", 90_000);
  const frame = await appFrame(page);
  const init = await waitFrameText(page, frame, "#status", /Initial result: Deploy board ready|tools\/call/, "the app finished the MCP Apps handshake (tool-result delivered)", 30_000);
  console.log(`FINDING app status after init: ${JSON.stringify(init)}`);
  await page.waitForTimeout(800);
  await shot("app-open");
  await frame.locator("#refresh").click();
  const one = await waitFrameText(page, frame, "#status", /tools\/call ok: staging v2\.14\.1 live, 3 pods healthy \(env=staging, check #1\)/, "first tools/call result inside the app (mcpServerStatus/list allowed it, mcpServer/tool/call ran it)");
  console.log(`FINDING first call: ${JSON.stringify(one)}`);
  await shot("tool-call-1");
  await frame.locator("#refresh").click();
  await waitFrameText(page, frame, "#status", /check #2\)/, "second call returns a fresh counter (computed per call)");
  await shot("tool-call-2");
  await frame.locator("#rotate").click();
  const hidden = await waitFrameText(page, frame, "#hidden", /rotate_keys refused/, "T3 refuses a tool whose visibility excludes apps");
  console.log(`FINDING hidden tool: ${JSON.stringify(hidden)}`);
  await page.waitForTimeout(800);
  await shot("hidden-tool-refused");
  await dumpPage(page, "s76 end");
}
