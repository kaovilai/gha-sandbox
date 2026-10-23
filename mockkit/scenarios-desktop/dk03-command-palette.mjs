// DK03 command palette opened with a REAL key chord (xdotool ctrl+k) into the focused Electron window, filtered, then dismissed.
// shot = real desktop capture (whole display).
import { startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env, native }) {
  await startSession(page, env);
  await native.key("ctrl+k", { settle: 1200 });
  const open = await page.getByRole("dialog").first().waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
  console.log(`FINDING command palette dialog visible after xdotool ctrl+k: ${open}`);
  await shot("palette-open");
  await native.xdo("type", "--delay", "60", "settings");
  await native.sleep(1000);
  await shot("palette-filtered");
  await native.key("Escape", { settle: 800 });
  await shot("palette-closed");
}
