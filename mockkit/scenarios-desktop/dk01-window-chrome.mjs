// DK01 window chrome + native popups: desktop-only. Real X11 captures (shot = root capture, not a renderer screenshot).
//  - window-full: the app window with Electron's own titleBarOverlay controls (min/max/close, top right). Xvfb runs no window manager,
//    so there is no WM-drawn frame.
//  - alt-pressed: Alt on a window with autoHideMenuBar + titleBarStyle "hidden"; run 39943262981 showed NO menu bar appears under Xvfb,
//    so the native File/Edit/View menu bar cannot be shown here (shot kept as evidence of that, named accordingly).
//  - context-menu-*: right-click opens a NATIVE popup menu (separate X window) which only a root capture can see.
import { ask, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env, native }) {
  await startSession(page, env);
  await native.sleep(800);
  await shot("window-full");
  console.log(`FINDING x11 window tree:\n${native.windowTree().split("\n").filter((l) => /T3|Electron|t3code|[0-9]x[0-9]/i.test(l)).slice(0, 25).join("\n")}`);

  await native.key("alt", { settle: 900 });
  await shot("alt-pressed");
  await native.key("Escape", { settle: 300 });

  await ask(page, env, "echo", "Hello from the desktop window.");
  await page.getByText(/Hello from the desktop window/).first().waitFor({ timeout: 60_000 });
  await native.sleep(2500);

  // right-click the thread row in the sidebar (leftmost match: x < 250)
  const boxes = [];
  for (const el of await page.getByText(/Hello from the desktop window/).all()) {
    const b = await el.boundingBox().catch(() => null);
    if (b && b.x < 250) boxes.push(b);
  }
  if (boxes[0]) {
    const b = boxes[0];
    native.move(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
    await native.sleep(300);
    native.xdo("click", 3);
    await native.sleep(1200);
    await shot("context-menu-thread");
    await native.key("Escape", { settle: 500 });
  } else {
    console.log("FINDING no sidebar thread row found for the context menu");
  }

  // right-click in the composer: Chromium's native edit menu
  const ed = await page.getByTestId("composer-editor").boundingBox();
  if (ed) {
    await native.click(Math.round(ed.x + ed.width / 2), Math.round(ed.y + ed.height / 2));
    await native.xdo("type", "--delay", "40", "teh");
    await native.sleep(500);
    native.xdo("click", 3);
    await native.sleep(1200);
    await shot("context-menu-composer");
    await native.key("Escape", { settle: 500 });
  }
}
