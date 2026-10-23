// S31 sidebar thread actions: three threads; context menu (right click) -> pin, settle, snooze, rename, archive.
import { composerEditor, dumpPage, sendPrompt, startSession } from "../lib/ui.mjs";

const PROMPTS = ["Alpha thread first task", "Bravo thread second task", "Charlie thread third task"];

export default async function ({ page, shot, env }) {
  const project = await startSession(page, env);
  const failures = [];
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      failures.push(name);
      console.log(`FINDING step "${name}" failed: ${String(e.message).split("\n")[0]}`);
      await dumpPage(page, `s31 failure in ${name}`).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
  };

  for (let i = 0; i < PROMPTS.length; i++) {
    if (i > 0) {
      await page.getByRole("button", { name: `New thread in ${project}` }).first().click();
      await composerEditor(page).waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(1500);
    }
    await sendPrompt(page, PROMPTS[i]);
    await page.getByText(/Mock agent, turn 1/).last().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2500);
  await shot("three-threads");
  await dumpPage(page, "s31 three threads");

  const row = (title) => page.getByText(title, { exact: false }).first();
  const openMenu = async (title) => {
    await row(title).click({ button: "right" });
    await page.waitForTimeout(700);
  };
  const clickItem = async (re) => {
    const it = page.getByText(re).last();
    await it.waitFor({ state: "visible", timeout: 8000 });
    await it.click();
    await page.waitForTimeout(900);
  };

  await step("menu", async () => {
    await openMenu("Alpha thread");
    await shot("context-menu");
    await dumpPage(page, "s31 context menu");
  });
  await step("pin", async () => {
    await clickItem(/^Pin thread$/);
    await shot("pinned");
  });
  await step("settle", async () => {
    await openMenu("Bravo thread");
    await clickItem(/^Settle thread$/);
    await shot("settled");
  });
  await step("snooze", async () => {
    await openMenu("Charlie thread");
    const sn = page.getByText(/^Snooze$/).last();
    await sn.waitFor({ state: "visible", timeout: 8000 });
    await sn.hover();
    await page.waitForTimeout(900);
    await shot("snooze-submenu");
    await dumpPage(page, "s31 snooze submenu");
    await sn.click();
    await page.waitForTimeout(700);
    const preset = page.getByText(/\(.*\)$/).filter({ hasNotText: /Custom/ }).last();
    await preset.click();
    await page.waitForTimeout(1200);
    await shot("snoozed");
  });
  await step("rename", async () => {
    await openMenu("Alpha thread");
    await clickItem(/^Rename thread$/);
    await page.waitForTimeout(600);
    await shot("rename-input");
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Renamed alpha thread");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    await shot("renamed");
  });
  await step("archive", async () => {
    await openMenu("Bravo thread");
    await clickItem(/^Archive thread$/);
    await page.waitForTimeout(800);
    await shot("archived-undo-notice");
  });
  await dumpPage(page, "s31 final");
  if (failures.length) throw new Error(`sidebar actions failed: ${failures.join(", ")}`);
}
