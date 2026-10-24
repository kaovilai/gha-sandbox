// S37 files browser: right panel "Files" surface = a tree (@pierre/trees, rows live in SHADOW DOM) + file previews.
// Rows are real <button role="treeitem" data-item-path="..."> elements: they are located by attribute (the unique,
// non-"parked" copy; a text locator hits the off-screen parked duplicate and its click never lands) and clicked for real
// (ladder: normal click -> forced click -> dispatched click -> keyboard Enter; the working method is logged and the
// opened tab is asserted). Previews: source (text), markdown (source, then the RENDERED preview via the toggle), csv table,
// svg image (loaded <img>). Plus tree search and the Ctrl+P file picker.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { MASK_HOME, MASK_HOST, maskStats } from "../lib/mask.mjs";
import { bodyText, dumpPage, expectBody, expectNoLocator, expectText, expectVisible, sendPrompt, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

// Runner identity that really appears inside SHADOW DOM surfaces (file tree row label, code view, diff panel): the masking proof.
const HOST = hostname().split(".")[0];

function seedFiles(ws) {
  mkdirSync(join(ws, "docs"), { recursive: true });
  mkdirSync(join(ws, "assets"), { recursive: true });
  mkdirSync(join(ws, "data"), { recursive: true });
  writeFileSync(
    join(ws, "docs/guide.md"),
    "# Guide\n\nThis guide shows how `greet()` is used.\n\n## Steps\n\n1. Import the helper\n2. Call it with a name\n3. Print the result\n\n```ts\nimport { greet } from \"../src/greeting\";\nconsole.log(greet(\"T3\"));\n```\n\n| Name | Role |\n| --- | --- |\n| greet | hello |\n| farewell | bye |\n",
  );
  writeFileSync(
    join(ws, "assets/logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" rx="16" fill="#1e293b"/><circle cx="60" cy="60" r="32" fill="#38bdf8"/><rect x="110" y="40" width="100" height="14" rx="7" fill="#f8fafc"/><rect x="110" y="66" width="70" height="14" rx="7" fill="#94a3b8"/></svg>\n',
  );
  writeFileSync(join(ws, "data/people.csv"), "name,team,score\nAda,core,91\nGrace,infra,88\nLinus,kernel,95\n");
  // text that names the runner: a log file called after the host (tree row label) and a note with absolute paths (code view, later the diff)
  mkdirSync(join(ws, "logs"), { recursive: true });
  writeFileSync(join(ws, "logs", `${HOST}.log`), `boot ok on ${HOST}\n`);
  writeFileSync(join(ws, "docs/ci-env.txt"), `cwd=${ws}\nhost=${HOST}\n`);
  const g = (...a) => execFileSync("git", a, { cwd: ws, stdio: "inherit", env: { ...process.env, GIT_AUTHOR_NAME: "Mock", GIT_AUTHOR_EMAIL: "mock@example.invalid", GIT_COMMITTER_NAME: "Mock", GIT_COMMITTER_EMAIL: "mock@example.invalid" } });
  g("add", "docs", "assets", "data", "logs");
  g("commit", "-q", "-m", "Add docs and assets");
}

// tree rows (shadow DOM, Playwright CSS pierces open shadow roots); parked/sticky copies excluded
const ROWS = '[data-type="item"][role="treeitem"]:not([data-item-parked])';
const fileRow = (page, path) => page.locator(`${ROWS}[data-item-type="file"][data-item-path="${path}"]`).first();
const dirRow = (page, path) => page.locator(`${ROWS}[data-item-type="folder"]:is([data-item-path="${path}"],[data-item-path="${path}/"])`).first();

async function dumpTree(page, label) {
  const rows = await page.locator(ROWS).evaluateAll((els) => els.map((e) => `${e.getAttribute("data-item-type")}|${e.getAttribute("data-item-path")}|exp=${e.getAttribute("aria-expanded")}|sel=${e.getAttribute("aria-selected")}`));
  console.log(`::group::tree rows ${label} (${rows.length})\n${rows.join("\n")}\n::endgroup::`);
  return rows;
}

// Click a tree row; returns how it worked. `done()` confirms the click had its effect.
async function clickRow(page, loc, done, what) {
  await loc.waitFor({ state: "attached", timeout: 15_000 });
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const tries = [
    ["click", () => loc.click({ timeout: 4000 })],
    ["force-click", () => loc.click({ force: true, timeout: 4000 })],
    ["dispatch-click", () => loc.dispatchEvent("click")],
    ["keyboard-enter", async () => {
      await loc.focus();
      await page.keyboard.press("Enter");
    }],
  ];
  for (const [how, fn] of tries) {
    try {
      await fn();
    } catch (e) {
      console.log(`tree click '${what}' via ${how} threw: ${String(e.message).split("\n")[0]}`);
      continue;
    }
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(300);
      if (await done()) {
        console.log(`tree row '${what}' opened via ${how}`);
        return how;
      }
    }
    console.log(`tree click '${what}' via ${how}: no effect, trying next method`);
  }
  await dumpTree(page, `after failed click on ${what}`);
  await dumpPage(page, `s37 tree click failed: ${what}`);
  throw new Error(`assertion failed: tree row '${what}' could not be clicked by any method`);
}

export default async function ({ page, shot, env }) {
  seedFiles(env.MOCKKIT_WS);
  await startSession(page, env);
  await page.waitForTimeout(1000);
  await page.keyboard.press("Control+Alt+B");
  await page.waitForTimeout(1000);
  await shot("right-panel-launcher");
  await dumpPage(page, "s37 launcher");
  const filesBtn = page.getByRole("button", { name: /^Files/ }).first();
  await must(page, filesBtn, "Files surface button");
  await filesBtn.click();
  await page.waitForTimeout(1500);

  // the tree lists the workspace's top level
  await expectVisible(page, page.locator(ROWS).first(), "file tree rows (shadow DOM)", 30_000);
  const rows = await dumpTree(page, "initial");
  for (const want of ["file|README.md", "file|package.json"]) {
    if (!rows.some((r) => r.startsWith(want))) throw new Error(`assertion failed: tree has no row ${want}`);
  }
  for (const d of ["src", "docs", "data", "assets"]) await expectVisible(page, dirRow(page, d), `tree folder row '${d}'`);
  await shot("files-tree");
  await dumpPage(page, "s37 files tree");

  // expand a folder by clicking it: aria-expanded flips and its file row appears
  const expand = async (d, child) => {
    await clickRow(page, dirRow(page, d), async () => (await dirRow(page, d).getAttribute("aria-expanded").catch(() => null)) === "true", `folder ${d}`);
    await expectVisible(page, fileRow(page, child), `row '${child}' after expanding '${d}'`);
  };
  const opened = (name) => async () => new RegExp(name.replace(/\./g, "\\.")).test(await bodyText(page));
  const open = async (dir, file) => {
    const path = `${dir}/${file}`;
    await expand(dir, path);
    const how = await clickRow(page, fileRow(page, path), opened(file), path);
    await page.waitForTimeout(1500);
    return how;
  };

  const failures = [];
  const step = async (n, fn) => {
    try {
      await fn();
    } catch (e) {
      failures.push(n);
      console.log(`FINDING ${n}: ${String(e.message).split("\n")[0]}`);
      await shot(`${n.replace(/\W+/g, "-")}-FAILED`).catch(() => {});
    }
  };

  await step("source preview", async () => {
    await open("src", "greeting.ts");
    await expectText(page, /export function greet\(name: string\): string/, "greeting.ts source in the preview");
    await shot("preview-source");
  });
  await step("markdown preview", async () => {
    await open("docs", "guide.md");
    // default is the markdown SOURCE view (toggle label 'Show rendered markdown')
    await expectText(page, /# Guide/, "guide.md shown as source first ('# Guide')");
    await shot("preview-markdown-source");
    const toggle = page.getByRole("button", { name: "Show rendered markdown" }).first();
    await expectVisible(page, toggle, "'Show rendered markdown' toggle in the file header");
    await toggle.click();
    await page.waitForTimeout(1200);
    // rendered: a real heading + list + table + highlighted code, and the raw markdown markers are gone
    await expectVisible(page, page.getByRole("heading", { name: "Guide", exact: true }), "rendered <h1> 'Guide'");
    await expectVisible(page, page.getByRole("heading", { name: "Steps", exact: true }), "rendered <h2> 'Steps'");
    await expectVisible(page, page.getByRole("listitem").filter({ hasText: "Call it with a name" }), "rendered ordered-list item");
    await expectVisible(page, page.locator("table").filter({ hasText: "farewell" }), "rendered table with the 'farewell' row");
    if (await page.getByText(/# Guide/).first().isVisible().catch(() => false)) throw new Error("assertion failed: raw '# Guide' still visible after rendering");
    await expectVisible(page, page.getByRole("button", { name: "Show markdown source" }), "toggle now offers 'Show markdown source'");
    await shot("preview-markdown");
  });
  await step("csv preview", async () => {
    await open("data", "people.csv");
    const table = page.locator("table").filter({ hasText: "Linus" });
    await expectVisible(page, table, "csv rendered as a table with the 'Linus' row");
    for (const cell of ["name", "team", "score", "Ada", "kernel", "95"]) await expectText(page, new RegExp(`^${cell}$`), `csv cell '${cell}'`);
    await shot("preview-csv");
  });
  await step("image preview", async () => {
    await open("assets", "logo.svg");
    const img = page.locator('img[alt="assets/logo.svg"]').first();
    await expectVisible(page, img, "svg rendered as an <img alt='assets/logo.svg'>");
    const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
    if (!ok) throw new Error("assertion failed: the svg <img> has no decoded pixels (naturalWidth 0)");
    await shot("preview-image");
  });
  await step("tree search", async () => {
    const search = page.getByPlaceholder("Search files").first();
    await expectVisible(page, search, "tree 'Search files' input");
    await search.fill("guide");
    await page.waitForTimeout(1200);
    await expectVisible(page, fileRow(page, "docs/guide.md"), "search keeps docs/guide.md");
    const hidden = await fileRow(page, "src/greeting.ts").isVisible().catch(() => false);
    if (hidden) throw new Error("assertion failed: non-matching row src/greeting.ts still listed while searching 'guide'");
    await shot("tree-search");
    await search.fill("");
    await page.waitForTimeout(600);
  });
  await step("file picker", async () => {
    await page.keyboard.press("Control+P");
    const input = await must(page, page.locator("input:visible").last(), "file picker input");
    await input.fill("logo");
    await page.waitForTimeout(1200);
    await expectBody(page, /assets\/logo\.svg|logo\.svg/, "file picker result for 'logo'");
    await shot("file-picker");
    await page.keyboard.press("Escape");
  });
  // masking in SHADOW DOM: tree row label, code view and diff panel all show text that names the runner (host, absolute workspace path)
  // (three independent steps: each reports its own finding, one CI run shows which surface still leaks)
  await step("masked tree row label", async () => {
    await expand("logs", `logs/${HOST}.log`);
    const row = fileRow(page, `logs/${HOST}.log`);
    const label = (await row.evaluate((e) => e.textContent)) ?? "";
    console.log(`FINDING tree row for logs/${HOST}.log shows ${JSON.stringify(label.trim())} (shadow roots observed: ${JSON.stringify(await maskStats(page))})`);
    if (label.includes(HOST) || !label.includes(MASK_HOST)) throw new Error(`assertion failed: tree row label should show '${MASK_HOST}' and not '${HOST}', got ${JSON.stringify(label.trim())}`);
    await expectNoLocator(page, page.getByText(HOST), `real host name '${HOST}' visible somewhere (tree row label?)`);
    await shot("masked-tree");
  });
  await step("masked code view", async () => {
    await open("docs", "ci-env.txt");
    await expectText(page, `cwd=${MASK_HOME}/demo-app`, "code view shows the masked workspace path (shadow DOM)");
    await expectText(page, `host=${MASK_HOST}`, "code view shows the masked host name (shadow DOM)");
    await expectNoLocator(page, page.getByText(env.MOCKKIT_WS), "real workspace path visible in the code view");
    await shot("masked-code-view");
  });
  await step("masked diff panel", async () => {
    // Diff/Changes exist only for a real server thread: one echo turn turns the draft into one
    await sendPrompt(page, "Summarize the CI environment notes.");
    await page.getByText(/turn 1/).first().waitFor({ timeout: 60_000 });
    // a working-tree change that names the paths: the Diff panel (shadow DOM) renders the added line
    appendFileSync(join(env.MOCKKIT_WS, "docs/ci-env.txt"), `changed: ${env.MOCKKIT_WS}/docs on ${HOST}\n`);
    await page.waitForTimeout(1500);
    const changes = page.getByRole("button", { name: /Changes/ }).first();
    await must(page, changes, "header Changes button");
    await changes.click();
    await page.waitForTimeout(2000);
    await expectText(page, "docs/ci-env.txt", "diff panel row docs/ci-env.txt");
    const box = await page.getByText("docs/ci-env.txt", { exact: true }).first().boundingBox();
    if (!box) throw new Error("assertion failed: no diff header box for docs/ci-env.txt");
    await page.mouse.click(Math.max(2, box.x - 42), box.y + box.height / 2); // chevron left of the header opens the hunk
    await page.waitForTimeout(1200);
    await expectText(page, new RegExp(`changed: ${MASK_HOME}/demo-app/docs on ${MASK_HOST}`), "diff added line shows the masked path + host (shadow DOM)");
    await expectNoLocator(page, page.getByText(env.MOCKKIT_WS), "real workspace path visible in the diff panel");
    await expectNoLocator(page, page.getByText(HOST), `real host name '${HOST}' visible in the diff panel`);
    await shot("masked-diff-panel");
  });
  await dumpPage(page, "s37 final");
  if (failures.length) throw new Error(`file previews failed: ${failures.join(", ")}`);
}
