// Standalone repro page (repro/ipad-keyboard.html): no framework, no build, no T3 Code — just the
// layout mechanics. Serve it with the `static` profile and drive it at an iPad-sized window.
//   gh workflow run sandbox.yml -f profile=static -f repo=kaovilai/gha-sandbox -f head_ref=main \
//     -f sides=after -f scenario=repro/scenario.mjs
import { run } from "../lib.mjs";

const PAGE = "repro/ipad-keyboard.html";

await run(
  async ({ page, shot }) => {
    await page.goto(`${process.env.APP_URL}${PAGE}`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const editor = page.locator("#editor");
    await editor.click();
    await editor.pressSequentially("First line of the prompt.", { delay: 4 });
    await editor.press("Enter");
    await editor.pressSequentially("Second line, typed with the keyboard open.", { delay: 4 });
    await page.waitForTimeout(300);
    console.log(`READOUT no keyboard: ${JSON.stringify(await page.locator("#readout").innerText())}`);
    await shot("01-no-keyboard");

    await page.evaluate(() => window.__kb.open(320));
    await page.waitForTimeout(400);
    console.log(`READOUT ipados: ${JSON.stringify(await page.locator("#readout").innerText())}`);
    await shot("02-ipados-keyboard-open");

    await page.evaluate(() => window.__kb.cutaway(true));
    await page.waitForTimeout(200);
    await shot("03-ipados-cutaway");
    await page.evaluate(() => window.__kb.cutaway(false));

    // the `/` menu, keyboard open
    await page.evaluate(() => {
      const ed = document.getElementById("editor");
      ed.textContent = "/";
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(300);
    console.log(`READOUT ipados menu: ${JSON.stringify(await page.locator("#readout").innerText())}`);
    await shot("04-ipados-slash-menu");

    // Chromium `resizes-content` contrast: shrink the layout viewport instead of overlaying it
    await page.evaluate(() => window.__kb.close());
    await page.setViewportSize({ width: 1080, height: 810 - 320 });
    await page.waitForTimeout(400);
    console.log(`READOUT chromium-resized: ${JSON.stringify(await page.locator("#readout").innerText())}`);
    await shot("05-chromium-resized");
  },
  {
    viewport: { width: 1080, height: 810 },
    contextOptions: { hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
  },
);
