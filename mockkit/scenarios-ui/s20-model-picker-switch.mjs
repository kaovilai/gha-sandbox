// S20 model picker: two mock provider instances; open the picker, browse, switch instance mid-thread, send a turn.
// The reply after the switch must be a natural answer to the user's message (the mock strips T3's internal context-handoff
// preamble, see lib/select.mjs stripHandoff), the thread shows the "Context handoff" row between the two models, and the
// composer reads the new model.
import { composerEditor, dumpPage, expectBody, expectNoText, expectText, expectVisible, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";
import { must, pickInstance, seedInstances } from "../lib/ui-extra.mjs";

// Under the codex pack the server is seeded with BOTH mock providers (Codex + Grok).
export const meta = { seed: { codex: "both" } };

async function assertSwitched({ page, newModel }) {
  // natural answer: the echo reply quotes only the user's message, never the handoff block T3 prepends after a provider switch
  await expectBody(page, /You said: "Now answer from the other provider\."/, "reply quotes the user's message after the switch", 90_000);
  await expectNoText(page, /Context handoff \(|Provider context handoff|full_thread_summary|Covered app runs/, "internal context-handoff prompt leaked into the visible reply");
  await expectBody(page, /Context handoff/, "'Context handoff' row between the two models in the timeline");
  await expectVisible(page, page.locator("button").filter({ hasText: newModel }), `composer model picker reads '${newModel}'`);
}

// Codex flavor: thread starts on Codex (GPT-6-Astra); the picker lists Codex models and the Grok models; switch to Grok mid-thread.
async function codexFlow({ page, shot, env }) {
  await startSession(page, env);
  await page.waitForTimeout(4000);
  await sendPrompt(page, "Hello from the default model.");
  await page.getByText(/Mock agent, turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await expectText(page, /You said: "Hello from the default model\."/, "first reply quotes the prompt");
  await shot("codex-reply");
  await page.keyboard.press("Control+Shift+M");
  await page.waitForTimeout(1200);
  await expectVisible(page, page.getByText(/GPT-6-Astra/).last(), "picker lists the Codex model GPT-6-Astra");
  await shot("picker-open-codex");
  await dumpPage(page, "s20 codex picker");
  await page.keyboard.press("Escape");
  await pickInstance(page, "Grok", { shot, model: "Mock Fast" });
  await composerEditor(page).click();
  await shot("composer-after-switch");
  await sendPrompt(page, "Now answer from the other provider.");
  await page.getByText(/Mock agent, turn/).nth(1).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1200);
  await assertSwitched({ page, newModel: "Mock Fast" });
  await shot("after-switch-turn");
  await dumpPage(page, "s20 codex after switch");
}

export default async function (a) {
  if (providerOf(a.env) === "codex") return codexFlow(a);
  const { page, shot, env } = a;
  seedInstances(env, { grok_alt: { displayName: "Mock Alt", accentColor: "#d97706" } });
  await startSession(page, env);
  await page.waitForTimeout(4000);
  await sendPrompt(page, "Hello from the default model.");
  await page.getByText(/Mock agent, turn 1/).first().waitFor({ timeout: 60_000 });
  await expectText(page, /You said: "Hello from the default model\."/, "first reply quotes the prompt");
  await page.keyboard.press("Control+Shift+M");
  await page.waitForTimeout(1200);
  await shot("picker-open");
  await dumpPage(page, "s20 picker (keyboard)");
  // provider rail of the picker: one icon button per instance (aria-label = display name)
  const altBtn = page.getByRole("button", { name: "Mock Alt" }).first();
  await must(page, altBtn, "Mock Alt provider button in picker");
  await altBtn.hover();
  await page.waitForTimeout(800);
  await shot("picker-alt-hover");
  await altBtn.click();
  await page.waitForTimeout(1000);
  await shot("picker-alt-selected");
  await dumpPage(page, "s20 alt selected");
  const pick = page.getByText(/Mock Fast/).first();
  await expectVisible(page, pick, "model 'Mock Fast' offered for the Mock Alt instance");
  await pick.click();
  await page.waitForTimeout(800);
  await page.keyboard.press("Escape");
  await composerEditor(page).click();
  await shot("composer-after-switch");
  await sendPrompt(page, "Now answer from the other provider.");
  await page.getByText(/Mock agent, turn/).nth(1).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1200);
  await assertSwitched({ page, newModel: "Mock Fast" });
  await shot("after-switch-turn");
  await dumpPage(page, "s20 after switch");
}
