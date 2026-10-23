// DK01 window chrome + native menu bar: desktop-only. Real X11 captures (shot = root capture, not a renderer screenshot):
// the app window with its titlebar overlay, then Alt (autoHideMenuBar reveals the native File/Edit/View menu bar) and a menu opened by keyboard.
// Under Xvfb there is no window manager, so there is no WM-drawn frame; Electron's own titleBarOverlay is what shows.
import { startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env, native }) {
  await startSession(page, env);
  await native.sleep(800);
  await shot("window-full");
  console.log(`FINDING x11 window tree:\n${native.windowTree().split("\n").filter((l) => /T3|Electron|t3code|[0-9]x[0-9]/i.test(l)).slice(0, 25).join("\n")}`);

  await native.key("alt", { settle: 900 });
  await shot("menu-bar-alt");
  // keyboard navigation of the menu bar: first item is focused after Alt; Right moves to the next menu, Down opens it.
  await native.key("Right", { settle: 500 });
  await native.key("Right", { settle: 500 });
  await native.key("Down", { settle: 900 });
  await shot("menu-open");
  await native.key("Escape", { settle: 400 });
  await native.key("Escape", { settle: 400 });
  await shot("menu-closed");
}
