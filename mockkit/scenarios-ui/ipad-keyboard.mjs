// iPad keyboard repro (web): with an iPadOS keyboard open, the composer and the terminal drawer end up behind
// the keyboard, and the `/` menu is placed against the layout viewport, not the visible one.
//
// iPadOS ignores `interactive-widget=resizes-content` (apps/web/index.html), so the keyboard only shrinks
// window.visualViewport; the app's shell stays 100dvh and anchors the composer, the terminal drawer and the
// command menu to the bottom of the layout viewport. Android/desktop Chromium honor the hint and shrink the
// layout viewport instead, which is why the same build looks fine there.
//
// This driver measures both platform behaviors on the same page and the same iPad-sized window:
//   1. no keyboard                        -> reference
//   2. iPadOS: layout 810px, keyboard covers the bottom 320px (stubbed visualViewport + painted strip)
//   3. Android/desktop contrast: the layout viewport itself shrinks by 320px
// Findings are printed as FINDING lines; the run only fails when the emulation itself breaks.
import { expectVisible, composerEditor, startSession, dumpPage } from "../lib/ui.mjs";
import {
  IPAD_KEYBOARD_HEIGHT,
  caretPan,
  closeKeyboard,
  cutaway,
  installIpadKeyboardNow,
  keyboardState,
  measureScreen,
  openKeyboard,
  summarize,
} from "../lib/ipad-keyboard.mjs";

export const meta = {
  // iPad Air (5th gen) landscape minus browser chrome, the shape from the report: a desktop-width layout.
  viewport: { width: 1080, height: 810 },
  contextOptions: { hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
};

const LONG_PROMPT = [
  "Outline the migration plan for the payments service.",
  "Include the rollout order and the rollback step for each stage.",
  "Call out every place the schema change needs a backfill.",
  "Finish with the two risks you would watch during the first week.",
].join("\n");

async function report(page, label) {
  const screen = await measureScreen(page);
  console.log(`FINDING ${label}: ${summarize(screen)}`);
  if (screen.composerControls.length) {
    console.log(`FINDING ${label} composer controls: ${JSON.stringify(screen.composerControls.filter((c) => c.label).slice(0, 8))}`);
  }
  return screen;
}

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await page.waitForTimeout(1000);
  await installIpadKeyboardNow(page); // the keyboard stub + strip the scenario drives below
  // Provider-update toasts are not part of the bug; keep them out of the shots (they pop mid-run).
  await page.addStyleTag({
    content: '[role="alert"],[data-slot^="toast-portal"],[data-slot^="toast-viewport"]{display:none!important}',
  });

  // ---- 1. reference: no keyboard ---------------------------------------------------------------
  const ed = composerEditor(page);
  await ed.click();
  await ed.pressSequentially(LONG_PROMPT, { delay: 2 });
  await page.waitForTimeout(600);
  const noKeyboard = await report(page, "no keyboard");
  await shot("01-no-keyboard");

  // ---- 2. iPadOS: keyboard overlays the layout viewport ---------------------------------------
  await openKeyboard(page, IPAD_KEYBOARD_HEIGHT);
  await page.waitForTimeout(900);
  console.log(`FINDING keyboard state: ${JSON.stringify(await keyboardState(page))}`);
  const open = await report(page, "iPadOS keyboard open");
  await shot("02-ipados-keyboard-open");
  await cutaway(page, true);
  await shot("02b-ipados-keyboard-open-cutaway");
  await cutaway(page, false);
  if (!open.visualViewport || open.visualViewport.height !== open.layoutHeight - IPAD_KEYBOARD_HEIGHT) {
    throw new Error(`emulation broke: visualViewport ${JSON.stringify(open.visualViewport)} vs layout ${open.layoutHeight}`);
  }

  // typing while the keyboard is open: each new line moves the caret, so Safari has to pan further (the bounce)
  const pans = [];
  for (const line of ["\nand one more paragraph, typed with the keyboard open.", "\na fourth line.", "\nand a fifth."]) {
    await ed.pressSequentially(line, { delay: 2 });
    await page.waitForTimeout(250);
    pans.push(await caretPan(page));
  }
  console.log(`FINDING caret pans while typing: ${JSON.stringify(pans)}`);
  const typing = await report(page, "iPadOS, still typing");
  await shot("03-ipados-typing");

  // ---- 3. the `/` menu, keyboard open ---------------------------------------------------------
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await ed.pressSequentially("/", { delay: 60 });
  await page.waitForTimeout(1200);
  const menu = await report(page, "iPadOS, slash menu open");
  await shot("04-ipados-slash-menu");
  await cutaway(page, true);
  await shot("04b-ipados-slash-menu-cutaway");
  await cutaway(page, false);
  if (!menu.boxes.commandMenu) {
    await dumpPage(page, "ipad-keyboard: slash menu never opened");
    throw new Error("the `/` menu did not render ([data-composer-drawer-layer] absent)");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ---- 4. the terminal drawer, keyboard open ---------------------------------------------------
  const toggle = page.getByRole("button", { name: "Toggle terminal drawer" }).first();
  await expectVisible(page, toggle, "'Toggle terminal drawer' button in the thread header", 30_000);
  await toggle.click();
  const canvas = page.locator('[data-terminal-owner="drawer"] canvas').first();
  await expectVisible(page, canvas, "terminal canvas in the drawer", 30_000);
  await page.waitForTimeout(2500); // shell start + first prompt
  await canvas.click();
  await page.keyboard.type("printf 'ready\\n'; ls", { delay: 20 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const terminal = await report(page, "iPadOS, terminal drawer");
  await shot("05-ipados-terminal");
  await cutaway(page, true);
  await shot("05b-ipados-terminal-cutaway");
  await cutaway(page, false);
  await toggle.click().catch(() => {});
  await page.waitForTimeout(500);

  // ---- 5. Android/desktop contrast: the layout viewport shrinks with the keyboard ----------------
  await closeKeyboard(page);
  await page.setViewportSize({ width: 1080, height: 810 - IPAD_KEYBOARD_HEIGHT });
  await page.waitForTimeout(900);
  await composerEditor(page).click();
  const resized = await report(page, "Chromium/Android resizes-content contrast");
  await shot("06-chromium-resized");

  // ---- verdict ----------------------------------------------------------------------------------
  const verdict = {
    noKeyboardComposerCovered: noKeyboard.coveredByKeyboard.composer,
    ipadosComposerCovered: typing.coveredByKeyboard.composer,
    ipadosSendCovered: typing.coveredByKeyboard.sendButton,
    ipadosTerminalCovered: terminal.coveredByKeyboard.terminalDrawer,
    ipadosMenuCovered: menu.coveredByKeyboard.commandMenu,
    chromiumComposerCovered: resized.coveredByKeyboard.composer,
    pageScrollable: typing.documentScrollable,
  };
  console.log(`FINDING verdict: ${JSON.stringify(verdict)}`);
  const reproduced = verdict.ipadosComposerCovered > 0 || verdict.ipadosSendCovered > 0 || verdict.ipadosTerminalCovered > 0;
  console.log(
    reproduced
      ? "RESULT ipad-keyboard BUG REPRODUCED (iPadOS overlay state hides the composer/terminal; Chromium resized state does not)"
      : "RESULT ipad-keyboard NOT REPRODUCED (the composer stayed inside the visible area in every state)",
  );
  if (!reproduced) {
    await dumpPage(page, "ipad-keyboard: not reproduced");
    throw new Error("the keyboard overlay state did not cover the composer, terminal or send button; nothing to report");
  }
}
