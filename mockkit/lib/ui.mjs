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

export function composerLocator(page) {
  return page.locator('[contenteditable="true"]').last();
}

// Type into the composer and send with Enter.
export async function sendPrompt(page, text, { delay = 12 } = {}) {
  const ed = composerLocator(page);
  await ed.waitFor({ state: "visible", timeout: 30_000 });
  await ed.click();
  await ed.pressSequentially(text, { delay });
  await page.keyboard.press("Enter");
}
