// S07 shell-command-output: REAL `sh -c` loop (8 steps x 1 s, ANSI colour) streamed as tool output while running.
// Mid-stream still: expand the live command row as soon as it exists, poll the DOM until "step 3/8".."step 5/8" is
// visible, then capture immediately (no fixed sleeps). The final still shows all 8 steps + "build finished".
import { ask, dumpPage, expandRows, expandWork, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "shell", "Run the build.");

  const mid = /step [3-5]\/8/;
  const late = /step [6-8]\/8|build finished/;
  const t0 = Date.now();
  let captured = false;
  let sawRunning = false;
  while (Date.now() - t0 < 40_000) {
    const text = await page.evaluate(() => document.body.innerText);
    if (mid.test(text)) {
      await shot("running-midstream");
      captured = true;
      console.log(`FINDING mid-stream still captured ${Date.now() - t0}ms after send; visible: ${(text.match(/step \d\/8/g) ?? []).join(",")}`);
      break;
    }
    if (late.test(text)) break; // output already past the window: stop, report below
    if (!sawRunning && /Running command|npm run build/.test(text)) {
      await shot("running-collapsed");
      sawRunning = true;
    }
    await expandRows(page, { hasText: /npm run build|while \[|command/i }); // only opens collapsed rows, never toggles shut
    await page.waitForTimeout(250);
  }
  await dumpPage(page, "s07 mid-run");
  if (!captured) {
    await shot("midstream-MISSED");
    throw new Error("S07: never observed 'step 3..5/8' output in the UI while the command was running");
  }

  await page.getByText(/finished successfully/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await expandWork(page);
  await expandRows(page, { hasText: /npm run build|while \[|command/i });
  await page.getByText(/build finished/).first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await shot("done");
  await dumpPage(page, "s07 done");
}
