// Shared Playwright helpers for T3 Code UI drivers.
import { next as queueNext } from "../ctl/mockctl.mjs";

// Skip the first-run wizard (web reads this localStorage key: apps/web/src/clientPersistenceStorage.ts).
export async function skipOnboarding(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("t3code:client-settings:v1", JSON.stringify({ onboardingCompletedAt: "2026-01-01T00:00:00.000Z" }));
    } catch {}
  });
}

// Print what is on screen (used by exploratory drivers and on failure) so CI logs show the UI state.
export async function dumpPage(page, label = "page") {
  const info = await page.evaluate(() => ({
    href: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 4000),
    buttons: [...document.querySelectorAll("button,[role=button],a[href]")]
      .slice(0, 120)
      .map((b) => `${b.tagName.toLowerCase()}|${b.getAttribute("aria-label") ?? ""}|${(b.textContent ?? "").trim().slice(0, 40)}|${b.getAttribute("href") ?? ""}|${b.getAttribute("data-testid") ?? ""}|exp=${b.getAttribute("aria-expanded") ?? ""}|${b.getAttribute("data-v2-item-type") ?? ""}`),
    editable: [...document.querySelectorAll('[contenteditable="true"],textarea,input')]
      .slice(0, 10)
      .map((e) => `${e.tagName.toLowerCase()}|${e.getAttribute("aria-label") ?? ""}|${e.getAttribute("placeholder") ?? ""}|${e.getAttribute("data-testid") ?? ""}|${e.className.toString().slice(0, 60)}`),
  }));
  console.log(`::group::dump ${label}\nhref=${info.href}\ntitle=${info.title}\n--- text ---\n${info.text}\n--- controls ---\n${info.buttons.join("\n")}\n--- editable ---\n${info.editable.join("\n")}\n::endgroup::`);
  return info;
}

export const composerEditor = (page) => page.getByTestId("composer-editor");

// Type into the composer and send with Enter (default send shortcut).
export async function sendPrompt(page, text, { delay = 12 } = {}) {
  const ed = composerEditor(page);
  await ed.waitFor({ state: "visible", timeout: 30_000 });
  await ed.click();
  await ed.pressSequentially(text, { delay });
  await page.keyboard.press("Enter");
}

// Fail loudly (with a page dump) instead of continuing on a broken shell.
export async function assertShell(page, label = "app shell", timeout = 60_000) {
  const addBtn = page.getByRole("button", { name: "Add project" }).first();
  try {
    await addBtn.waitFor({ state: "visible", timeout });
  } catch (e) {
    const info = await dumpPage(page, `${label} not ready`).catch(() => null);
    const why = /invalid|expired|unauthori[sz]ed|pairing/i.test(info?.text ?? "") ? " (page text mentions pairing/auth: token invalid or already used?)" : "";
    throw new Error(`${label}: sidebar "Add project" never became visible within ${timeout}ms${why}; url=${page.url()}`);
  }
}

// Add the per-scenario workspace (a small repo created by mockkit/seed/workspace.sh) as a project via the
// sidebar "Add project" button. Returns the project name shown in the sidebar (dir basename).
export async function addProject(page, wsPath, { shot } = {}) {
  const name = wsPath.split("/").filter(Boolean).at(-1);
  await assertShell(page);
  await page.getByRole("button", { name: "Add project" }).first().click();
  const input = page.locator("input:visible").last();
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await shot?.("add-project");
  await input.fill(wsPath);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");
  try {
    await page.getByRole("button", { name: `New thread in ${name}` }).first().waitFor({ state: "visible", timeout: 30_000 });
  } catch (e) {
    await dumpPage(page, "after add project (project not listed)");
    throw new Error(`project "${name}" (${wsPath}) did not appear in the sidebar`);
  }
  return name;
}

// Which mock provider a driver runs against: env.MOCKKIT_PROVIDER = grok (default) | codex (set per scenario by scenario.mjs).
export const providerOf = (env) => (env?.MOCKKIT_PROVIDER === "codex" ? "codex" : "grok");

// Start a fresh thread in the project and make sure the composer targets the mock model. Polls until the mock
// provider is selectable (READY); fails loudly when it never shows up. provider "codex" = the Codex-driver mock
// (models gpt-6-astra / gpt-6-luna / gpt-5.6-sol, shown by T3 as "GPT-6-Astra" ...).
export async function newMockThread(page, { project, shot, provider = "grok" } = {}) {
  await page.getByRole("button", { name: `New thread in ${project}` }).first().click();
  await composerEditor(page).waitFor({ state: "visible", timeout: 30_000 });
  const codex = provider === "codex";
  const wantLabel = codex ? /gpt-6-astra|gpt-6-luna|gpt-5\.6-sol/i : /Mock/i;
  const pickerLoc = () => page.locator("button").filter({ hasText: /Mock (Build|Fast)|gpt-|claude|opus|sonnet|grok/i }).last();
  const deadline = Date.now() + 90_000;
  let label = "";
  while (Date.now() < deadline) {
    label = ((await pickerLoc().textContent({ timeout: 2000 }).catch(() => "")) ?? "").trim();
    if (wantLabel.test(label)) {
      console.log(`composer model picker: "${label}"`);
      return;
    }
    if (label) {
      await pickerLoc().click().catch(() => {});
      if (codex) {
        // provider rail: one icon button per instance (aria-label = display name)
        const rail = page.getByRole("button", { name: /^Codex$/i }).first();
        if (await rail.isVisible({ timeout: 1500 }).catch(() => false)) await rail.click().catch(() => {});
      }
      const opt = codex ? page.getByText(/GPT-6-Astra/i).last() : page.getByText("Mock Build", { exact: false }).first();
      if (await opt.isVisible({ timeout: 1500 }).catch(() => false)) {
        await shot?.("model-picker");
        await opt.click();
        await page.waitForTimeout(500);
        continue;
      }
      await page.keyboard.press("Escape").catch(() => {});
    }
    await page.waitForTimeout(1000);
  }
  await dumpPage(page, "model picker (mock never selectable)");
  throw new Error(`mock ${provider} provider never became selectable in the composer (picker label: "${label}")`);
}

export async function waitText(page, matcher, timeout = 60_000) {
  await page.getByText(matcher).first().waitFor({ state: "visible", timeout });
}

// Fresh mock-backed thread inside this scenario's own workspace project (env.MOCKKIT_WS; one server per scenario).
export async function startSession(page, env) {
  const project = await addProject(page, env.MOCKKIT_WS);
  await newMockThread(page, { project, provider: providerOf(env) });
  return project;
}

// Hidden routing: the NEXT user turn in this scenario's workspace runs mock scenario <id>; no "[mock:..]" in the UI.
export function nextScenario(env, id, args = {}) {
  queueNext(id, args, { cwd: env.MOCKKIT_WS, env });
}

// Queue scenario <id> for the next turn, then type a natural prompt.
export async function ask(page, env, id, prompt, args = {}) {
  nextScenario(env, id, args);
  await sendPrompt(page, prompt);
}

// Expand the collapsed "Worked for Ns" work log (tool calls / reasoning) when present.
export async function expandWork(page) {
  const row = page.getByText(/^Worked for/).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click().catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

// Click every collapsed timeline row (role=button aria-expanded=false) matching `filter`; returns how many were opened.
// Rows expose data-v2-item-type (e.g. "reasoning") and aria-expanded (apps/web TimelineWorkEntryRow).
export async function expandRows(page, { type, hasText } = {}) {
  let sel = `[role="button"][aria-expanded="false"]`;
  if (type) sel = `[data-v2-item-type*="${type}"]${sel}`;
  let loc = page.locator(sel);
  if (hasText) loc = loc.filter({ hasText });
  let n = 0;
  for (const el of await loc.all()) {
    if (await el.isVisible().catch(() => false)) {
      await el.click().catch(() => {});
      n += 1;
    }
  }
  if (n) await page.waitForTimeout(600);
  return n;
}

// Switch the composer runtime mode (default "Full access" auto-approves everything, so no prompts).
export async function setRuntimeMode(page, labelRe, { shot } = {}) {
  // The aria-label only exists once the thread has messages, so match on the visible mode text.
  await page.locator("button").filter({ hasText: /^\s*(Full access|Supervised|Auto[- ]?accept.*|Auto)\s*$/i }).last().click();
  await page.waitForTimeout(500);
  await shot?.("runtime-mode-menu");
  await dumpPage(page, "runtime mode menu");
  await page
    .getByRole("menuitemradio", { name: labelRe })
    .or(page.getByRole("menuitem", { name: labelRe }))
    .or(page.getByRole("option", { name: labelRe }))
    .or(page.getByText(labelRe))
    .last() // the popup is portaled to the end of the DOM
    .click();
  await page.waitForTimeout(500);
}
