// S07 shell-command-output: REAL `sh -c` loop (8 steps x 1 s, ANSI colour) streamed as tool output while running.
// While the command runs we poll the DOM (no fixed sleeps): if T3 renders the streamed stdout ("step 3/8".."5/8") we
// capture it as `running-midstream`; otherwise we capture the genuine in-progress state (`running-live-status`: "Working
// for Ns", "Running command" row, red stop button) and log a FINDING that live stdout is not rendered for running
// commands. The final still shows the completed output (all 8 steps + "build finished").
import { ask, dumpPage, expandRows, expandWork, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "shell", "Run the build.");

  const t0 = Date.now();
  let midstream = false;
  let live = false;
  while (Date.now() - t0 < 40_000) {
    const text = await page.evaluate(() => document.body.innerText);
    if (/step [3-5]\/8/.test(text)) {
      await shot("running-midstream");
      midstream = true;
      console.log(`FINDING live stdout rendered mid-run (${Date.now() - t0}ms): ${(text.match(/step \d\/8/g) ?? []).join(",")}`);
      break;
    }
    if (/finished successfully|Worked for/.test(text)) break; // turn already over
    if (!live && /Working for [2-5]s/.test(text) && /Running command/.test(text)) {
      await shot("running-live-status");
      live = true;
      console.log(`FINDING in-progress still captured ${Date.now() - t0}ms after send (row "Running command")`);
    }
    await expandRows(page, { hasText: /Running command|npm run build|while \[/i }); // only opens collapsed rows
    await page.waitForTimeout(250);
  }
  if (!midstream) console.log("FINDING live stdout NOT rendered while the command ran (running row not expandable / no output lines)");
  await dumpPage(page, "s07 mid-run");
  if (!midstream && !live) {
    await shot("running-MISSED");
    throw new Error("S07: captured neither live stdout nor the in-progress 'Running command' state");
  }

  await page.getByText(/finished successfully/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await expandWork(page);
  await expandRows(page, { hasText: /npm run build|while \[|command/i });
  if (!(await page.getByText(/compiling module-8/).first().isVisible().catch(() => false))) {
    await page.getByText(/while \[/).first().click().catch(() => {}); // the command row label is the command text
  }
  await page.getByText(/compiling module-8/).first().waitFor({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await shot("done");
  await dumpPage(page, "s07 done");
}
