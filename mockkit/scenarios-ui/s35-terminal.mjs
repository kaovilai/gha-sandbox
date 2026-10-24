// S35 terminal: the thread's terminal drawer (Ghostty WASM surface, text drawn on a <canvas>: not in the DOM at all) running a REAL
// shell in the workspace. The shell prompt and `pwd` / `hostname` output name the runner (hostname, /home/runner/work/... path);
// mask.mjs rewrites the canvas `fillText` strings before they are drawn, so the PNG/video show `sandbox-vm` and /home/dev/... only.
// Proof, not "the flow ran": (1) a command typed into the terminal wrote a file on disk (cwd == the workspace, real hostname),
// (2) the canvas mask hook rewrote at least one drawn string (`maskStats.canvasMasked`), (3) the screenshot leak check found nothing.
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { maskStats } from "../lib/mask.mjs";
import { dumpPage, expectVisible, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  const toggle = page.getByRole("button", { name: "Toggle terminal drawer" }).first();
  await expectVisible(page, toggle, "'Toggle terminal drawer' button in the thread header", 30_000);
  await toggle.click();
  const canvas = page.locator('[data-terminal-owner="drawer"] canvas').first();
  await expectVisible(page, canvas, "terminal canvas in the drawer", 30_000);
  await page.waitForTimeout(2500); // shell start + first prompt
  await shot("terminal-prompt");

  // the proof file lives OUTSIDE the repo (workspace parent) so it never shows up in Changes
  const proof = join(env.MOCKKIT_WS, "..", ".term-proof");
  await canvas.click();
  await page.keyboard.type(`printf '%s\\n%s\\n' "$PWD" "$(hostname)" > ../.term-proof`, { delay: 8 });
  await page.keyboard.press("Enter");
  const t0 = Date.now();
  while (!existsSync(proof) || readFileSync(proof, "utf8").split("\n").length < 3) {
    if (Date.now() - t0 > 60_000) {
      await dumpPage(page, "s35 terminal: proof file never written");
      throw new Error("assertion failed: a command typed into the terminal drawer did not run (no proof file)");
    }
    await page.waitForTimeout(400);
  }
  const [cwd, host] = readFileSync(proof, "utf8").split("\n");
  console.log(`FINDING terminal shell cwd=${cwd} host=${host}`);
  if (cwd !== env.MOCKKIT_WS) throw new Error(`assertion failed: terminal cwd should be the workspace ${env.MOCKKIT_WS}, got ${cwd}`);
  if (host !== hostname()) throw new Error(`assertion failed: terminal hostname ${host} != ${hostname()}`);

  // visible output that names the runner (masked on screen by the canvas hook)
  await page.keyboard.type(`echo "cwd=$PWD host=$(hostname)"; pwd; whoami`, { delay: 8 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  const st = await maskStats(page);
  console.log(`FINDING mask stats after terminal output: ${JSON.stringify(st)}`);
  if (!st || st.canvasDraws === 0) throw new Error("assertion failed: the terminal drew nothing through the masked canvas hook (mask not installed?)");
  if (st.canvasMasked === 0) throw new Error(`assertion failed: no terminal canvas string needed masking although the shell printed the workspace path/hostname (${JSON.stringify(st)})`);
  await shot("terminal-output");
  await dumpPage(page, "s35 terminal");
}
