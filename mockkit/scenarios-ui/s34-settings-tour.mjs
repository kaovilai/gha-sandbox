// S34 settings tour: opens Settings from the sidebar and visits every section through the settings nav (diagnostics and
// open-source-licenses have no nav entry: routed), asserting each page's own content (breadcrumb "Settings / <name>" plus a
// marker only that page has). Then: settings search, appearance mode tiles (Light/Dark/System, aria-pressed + html.dark),
// the cycle shortcut, and a theme card (aria-pressed, "currently active").
import { dumpPage, expectBody, expectText, expectVisible, startSession } from "../lib/ui.mjs";
import { gotoPath } from "../lib/ui-extra.mjs";

// nav = settings-nav button label (null: reachable by route only); crumb = breadcrumb name; markers must ALL appear on the page
const SECTIONS = [
  { path: "general", nav: "General", crumb: "General", markers: [/Confirmations|Behavior|Projects & threads/] },
  { path: "appearance", nav: "Appearance", crumb: "Appearance", markers: [/Color scheme/, /Themes/] },
  { path: "keybindings", nav: "Keybindings", crumb: "Keybindings", markers: [/Add keybinding/, /Command Palette: Toggle/] },
  { path: "providers", nav: "Providers", crumb: "Providers", markers: [/Authenticated/, /Models/] },
  { path: "source-control", nav: "Source Control", crumb: "Source Control", markers: [/Repositories/, /Automatically pull/] },
  { path: "storage", nav: "Storage", crumb: "Storage", markers: [/Cleanup/, /Worktrees/] },
  { path: "connections", nav: "Connections", crumb: "Connections", markers: [/Authorized clients/, /No saved remote environments/] },
  { path: "diagnostics", nav: null, crumb: "Diagnostics", markers: [/Diagnostics/] },
  { path: "open-source-licenses", nav: null, crumb: "Open source licenses", markers: [/Third-party notices/, /\d+ notices/] },
];

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expectBody(page, /Settings\s*\/\s*General/, "settings opened on General (breadcrumb 'Settings / General')", 30_000);

  const failures = [];
  for (const s of SECTIONS) {
    try {
      if (s.nav) {
        const item = page.getByRole("button", { name: s.nav, exact: true }).first();
        await expectVisible(page, item, `settings nav entry '${s.nav}'`);
        await item.click();
      } else {
        await gotoPath(page, `/settings/${s.path}`);
      }
      await expectBody(page, new RegExp(`Settings\\s*/\\s*${s.crumb}`), `breadcrumb 'Settings / ${s.crumb}'`, 20_000);
      for (const m of s.markers) await expectBody(page, m, `settings/${s.path} content ${m}`, 30_000);
      if (s.path === "source-control") {
        // version-control discovery loads asynchronously (skeleton rows first): wait until real rows replace them
        const t0 = Date.now();
        while (Date.now() - t0 < 25_000 && (await page.locator('[data-slot="skeleton"], .animate-pulse').count()) > 0) await page.waitForTimeout(500);
        console.log(`FINDING source-control skeletons left after ${Date.now() - t0}ms: ${await page.locator('[data-slot="skeleton"], .animate-pulse').count()}`);
      }
      await page.waitForTimeout(800);
      await shot(`settings-${s.path}`);
      if (s.path === "general") await dumpPage(page, "s34 general");
    } catch (e) {
      failures.push(s.path);
      console.log(`FINDING settings/${s.path}: ${String(e.message).split("\n")[0]}`);
      await shot(`settings-${s.path}-FAILED`).catch(() => {});
    }
  }

  // settings search (sidebar combobox)
  try {
    const search = page.getByRole("combobox", { name: "Search settings" });
    await expectVisible(page, search, "settings search box");
    await search.click();
    await page.keyboard.type("theme", { delay: 50 });
    await page.waitForTimeout(900);
    await expectVisible(page, page.getByRole("option").first(), "settings search lists at least one result for 'theme'");
    await shot("settings-search-theme");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Clear settings search" }).click().catch(() => {});
  } catch (e) {
    failures.push("search");
    console.log(`FINDING settings search: ${String(e.message).split("\n")[0]}`);
  }

  // Appearance: mode tiles (real clicks), cycle shortcut, theme card
  await page.getByRole("button", { name: "Appearance", exact: true }).first().click();
  await expectBody(page, /Settings\s*\/\s*Appearance/, "appearance page");
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  const pressed = (label) => page.getByRole("button", { name: label, exact: true }).first().getAttribute("aria-pressed");
  const setMode = async (label, wantDark) => {
    await page.getByRole("button", { name: label, exact: true }).first().click();
    await page.waitForTimeout(800);
    const dark = await isDark();
    const p = await pressed(label);
    console.log(`FINDING click '${label}': aria-pressed=${p} html.dark=${dark}`);
    if (p !== "true") throw new Error(`assertion failed: '${label}' tile is not pressed after clicking it (aria-pressed=${p})`);
    if (dark !== wantDark) throw new Error(`assertion failed: after '${label}' html.dark=${dark}, expected ${wantDark}`);
  };
  await setMode("Use light mode", false);
  await shot("appearance-light");
  await setMode("Use dark mode", true);
  await shot("appearance-dark");
  await setMode("Use light mode", false);
  // keyboard shortcut cycles the mode: the pressed tile must change
  const before = await pressed("Use light mode");
  await page.keyboard.press("Control+Alt+Shift+A");
  await page.waitForTimeout(900);
  const afterLight = await pressed("Use light mode");
  console.log(`FINDING cycle shortcut: light tile aria-pressed ${before} -> ${afterLight}, html.dark=${await isDark()}`);
  if (afterLight === before) throw new Error("assertion failed: appearance.cycle shortcut did not change the selected mode");
  await shot("appearance-cycle");
  await setMode("Use dark mode", true);
  // theme card: pick a named theme (the card's name button), it becomes the active one
  const labels = await page.locator('button[aria-label^="Use "]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  console.log(`FINDING 'Use ...' buttons on the appearance page: ${JSON.stringify(labels)}`);
  // the name button selects the whole theme; the active state is shown on the card's light/dark preview circles (aria-pressed)
  const card = page.getByRole("button", { name: "Use Ocean theme", exact: true }).first();
  await card.scrollIntoViewIfNeeded();
  const themeBefore = await page.evaluate(() => document.documentElement.dataset.themeId ?? null);
  await card.click();
  await page.waitForTimeout(1000);
  const themeAfter = await page.evaluate(() => document.documentElement.dataset.themeId ?? null);
  const oceanDark = await pressed("Use Ocean dark mode");
  const oceanLight = await pressed("Use Ocean light mode");
  const defaultDark = await pressed("Use T3 Code dark mode");
  console.log(`FINDING theme card: html[data-theme-id] ${themeBefore} -> ${themeAfter}; Ocean light/dark pressed=${oceanLight}/${oceanDark}; T3 Code dark pressed=${defaultDark}`);
  if (oceanDark !== "true" || oceanLight !== "true" || defaultDark === "true") throw new Error(`assertion failed: Ocean is not the active theme after clicking its card (ocean light/dark pressed=${oceanLight}/${oceanDark}, T3 Code dark pressed=${defaultDark})`);
  await shot("theme-ocean-dark");
  if (failures.length) throw new Error(`settings sections failed: ${failures.join(", ")}`);
}
