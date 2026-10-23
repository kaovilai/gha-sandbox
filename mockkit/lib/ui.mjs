// Shared Playwright helpers for T3 Code UI drivers.

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
      .map((b) => `${b.tagName.toLowerCase()}|${b.getAttribute("aria-label") ?? ""}|${(b.textContent ?? "").trim().slice(0, 40)}|${b.getAttribute("href") ?? ""}|${b.getAttribute("data-testid") ?? ""}`),
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

// Add the seeded workspace (a small repo created by mockkit/seed/workspace.sh) as a project via the
// sidebar "Add project" button. Returns the project name shown in the sidebar (dir basename).
export async function addProject(page, wsPath, { shot } = {}) {
  const name = wsPath.split("/").filter(Boolean).at(-1);
  if (await page.getByRole("button", { name: `New thread in ${name}` }).first().isVisible().catch(() => false)) return name;
  await page.getByRole("button", { name: "Add project" }).first().click();
  await page.waitForTimeout(800);
  await shot?.("add-project");
  await dumpPage(page, "add project dialog");
  const input = page.locator("input:visible").last();
  await input.fill(wsPath);
  await page.waitForTimeout(500);
  await shot?.("add-project-filled");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  await dumpPage(page, "after add project");
  return name;
}

// Start a fresh thread (optionally in a named project) and make sure the composer targets the mock model.
export async function newMockThread(page, { project, shot } = {}) {
  const btn = project
    ? page.getByRole("button", { name: `New thread in ${project}` }).first()
    : page.getByRole("button", { name: "New thread", exact: true }).first();
  await btn.click();
  await composerEditor(page).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(800);
  const picker = page.locator("button").filter({ hasText: /Mock (Build|Fast)|gpt-|claude|opus|sonnet|grok/i }).last();
  const label = ((await picker.textContent().catch(() => "")) ?? "").trim();
  console.log(`composer model picker: "${label}"`);
  if (!/Mock/i.test(label)) {
    await picker.click();
    await page.waitForTimeout(600);
    await shot?.("model-picker");
    await dumpPage(page, "model picker");
    await page.getByText("Mock Build", { exact: false }).first().click();
    await page.waitForTimeout(500);
  }
}

export async function waitText(page, matcher, timeout = 60_000) {
  await page.getByText(matcher).first().waitFor({ state: "visible", timeout });
}

// Fresh mock-backed thread inside the seeded workspace project (shared by most drivers).
export async function startSession(page, env) {
  await page.waitForTimeout(2000);
  const project = await addProject(page, env.MOCKKIT_WS);
  await newMockThread(page, { project });
  return project;
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
