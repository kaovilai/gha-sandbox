// node --test mockkit/test : the in-page mask (shadow DOM, canvas text, focused inputs) in a REAL Chromium.
// Skipped when `playwright` / a browser is not available (the plain `mockkit-test` CI job installs neither); runs locally and wherever
// the harness deps are installed (`npm ci` + `npx playwright install chromium`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMaskRules, installMaskContext, MASK_HOME, MASK_HOST, maskNow, maskStats } from "../lib/mask.mjs";

let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {}

const ws = "/home/runner/work/_temp/mockkit-run/s37-files-browser/ws/demo-app";
const root = "/home/runner/work/_temp/mockkit-run/s37-files-browser";
const rules = buildMaskRules({ ws, root, tmp: "/home/runner/work/_temp", hostname: "runnervm8k3b6", home: "/home/runner" });

async function withPage(fn, { preInit } = {}) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    if (preInit) await context.addInitScript(preInit);
    await installMaskContext(context, rules);
    const page = await context.newPage();
    await page.goto("data:text/html,<!doctype html><body><div id=app>x</div></body>"); // a real navigation: the init script observes this document
    await fn(page);
  } finally {
    await browser.close();
  }
}

const canRun = chromium
  ? await chromium
      .launch()
      .then((b) => b.close().then(() => true))
      .catch(() => false)
  : false;
const t = (name, fn) => test(name, { skip: canRun ? false : "playwright/chromium not available" }, fn);

t("light DOM text is masked, including text added later", async () => {
  await withPage(async (page) => {
    await page.evaluate(([ws]) => {
      document.getElementById("app").textContent = `cwd ${ws} on runnervm8k3b6`;
    }, [ws]);
    await page.waitForTimeout(100);
    assert.equal(await page.innerText("#app"), `cwd ${MASK_HOME}/demo-app on ${MASK_HOST}`);
  });
});

t("open and closed shadow roots created AFTER the init script are masked and checked", async () => {
  await withPage(async (page) => {
    await page.evaluate(([ws]) => {
      const open = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
      open.innerHTML = `<span id=o>${ws}/src/a.ts</span>`;
      const closed = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "closed" });
      closed.innerHTML = `<span id=c>runnervm8k3b6</span>`;
      window.__closedText = () => closed.textContent;
      // text added to a nested shadow root later (tree rows are re-rendered like this)
      setTimeout(() => {
        const inner = open.appendChild(document.createElement("section")).attachShadow({ mode: "open" });
        inner.textContent = "/home/runner/work/_temp/x";
      }, 50);
    }, [ws]);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.querySelector("div:nth-of-type(2)").shadowRoot.getElementById("o").textContent), `${MASK_HOME}/demo-app/src/a.ts`);
    assert.equal(await page.evaluate(() => window.__closedText()), MASK_HOST);
    const leaks = await maskNow(page, rules);
    assert.deepEqual(leaks, []);
    const st = await maskStats(page);
    assert.ok(st.roots >= 3, JSON.stringify(st));
  });
});

t("MASK-LEAK check pierces shadow roots (a string the installed rules do not rewrite is reported)", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" }).innerHTML = "<p>token-in-shadow-42</p>";
    });
    // the in-page script only knows `rules`; the extra checkable rule is NOT applied there, so the shadow text stays and must be reported
    const leaks = await maskNow(page, [...rules, ["token-in-shadow-\\d+", "gi", "[x]"]]);
    assert.deepEqual(leaks, ["token-in-shadow-42"]);
    // and body.innerText alone would have missed it
    assert.equal(await page.evaluate(() => /token-in-shadow/.test(document.body.innerText)), false);
  });
});

t("shadow roots that existed BEFORE the mask was installed (desktop CDP attach) are found by the walk", async () => {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent("<!doctype html><body><div id=h></div></body>");
    await page.evaluate(() => {
      document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = "<i>/home/runner/work/_temp/mockkit-run/s37-files-browser/ws/demo-app/NOTES.md</i>";
    });
    const { installMaskPage } = await import("../lib/mask.mjs");
    await installMaskPage(page, rules);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.getElementById("h").shadowRoot.querySelector("i").textContent), `${MASK_HOME}/demo-app/NOTES.md`);
  } finally {
    await browser.close();
  }
});

t("canvas fillText strings are rewritten (padded to the original length)", async () => {
  await withPage(
    async (page) => {
      await page.evaluate(() => {
        const c = document.body.appendChild(document.createElement("canvas")).getContext("2d");
        c.fillText("runner@runnervm8k3b6:~/work/_temp/mockkit-run/s37-files-browser/ws/demo-app$ ", 0, 10, 600);
        c.fillText("plain text", 0, 20);
      });
      const calls = await page.evaluate(() => window.__drawn);
      assert.equal(calls.length, 2);
      assert.match(calls[0], /^runner@sandbox-vm:~\/demo-app\$ +$/);
      assert.equal(calls[0].length, "runner@runnervm8k3b6:~/work/_temp/mockkit-run/s37-files-browser/ws/demo-app$ ".length);
      assert.equal(calls[1], "plain text");
      const st = await maskStats(page);
      assert.equal(st.canvasMasked, 1);
      assert.equal(st.canvasDraws, 2);
    },
    {
      // runs BEFORE the mask init: records what the mask finally hands to the real fillText
      preInit: () => {
        window.__drawn = [];
        const o = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (t, ...r) {
          window.__drawn.push(t);
          return o.call(this, t, ...r);
        };
      },
    },
  );
});

t("a FOCUSED input keeps its real value but is drawn masked (overlay); blur rewrites the value", async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `<input id=i style="width:400px;font:14px monospace">`);
    });
    await page.click("#i");
    await page.keyboard.type(ws, { delay: 0 });
    await page.waitForTimeout(500);
    assert.equal(await page.inputValue("#i"), ws, "the real value must reach the app untouched while focused");
    assert.equal(await page.evaluate(() => document.querySelector("[data-mockkit-mask-overlay]")?.textContent ?? null), `${MASK_HOME}/demo-app`);
    assert.deepEqual(await maskNow(page, rules), [], "overlaid field counts as masked");
    assert.equal((await maskStats(page)).overlays, 1);
    await page.evaluate(() => document.getElementById("i").blur());
    await page.waitForTimeout(500);
    assert.equal(await page.inputValue("#i"), `${MASK_HOME}/demo-app`);
    assert.equal(await page.evaluate(() => document.querySelector("[data-mockkit-mask-overlay]")), null);
  });
});
