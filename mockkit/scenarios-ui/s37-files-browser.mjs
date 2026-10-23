// S37 files browser: right panel "Files" surface with tree + source / markdown / csv / image previews.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpPage, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

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
  const g = (...a) => execFileSync("git", a, { cwd: ws, stdio: "inherit", env: { ...process.env, GIT_AUTHOR_NAME: "Mock", GIT_AUTHOR_EMAIL: "mock@example.invalid", GIT_COMMITTER_NAME: "Mock", GIT_COMMITTER_EMAIL: "mock@example.invalid" } });
  g("add", "docs", "assets", "data");
  g("commit", "-q", "-m", "Add docs and assets");
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
  await shot("files-tree");
  await dumpPage(page, "s37 files tree");
  const open = async (name, tag) => {
    const row = page.getByText(name, { exact: true }).first();
    await must(page, row, `tree row ${name}`);
    await row.click();
    await page.waitForTimeout(1500);
    await shot(tag);
  };
  const failures = [];
  const step = async (n, fn) => {
    try {
      await fn();
    } catch (e) {
      failures.push(n);
      console.log(`FINDING ${n}: ${String(e.message).split("\n")[0]}`);
    }
  };
  await step("expand src", async () => {
    await page.getByText("src", { exact: true }).first().click();
    await page.waitForTimeout(800);
  });
  await step("source preview", () => open("greeting.ts", "preview-source"));
  await step("expand docs", async () => {
    await page.getByText("docs", { exact: true }).first().click();
    await page.waitForTimeout(800);
  });
  await step("markdown preview", () => open("guide.md", "preview-markdown"));
  await step("expand data", async () => {
    await page.getByText("data", { exact: true }).first().click();
    await page.waitForTimeout(800);
  });
  await step("csv preview", () => open("people.csv", "preview-csv"));
  await step("expand assets", async () => {
    await page.getByText("assets", { exact: true }).first().click();
    await page.waitForTimeout(800);
  });
  await step("image preview", () => open("logo.svg", "preview-image"));
  await dumpPage(page, "s37 final");
  if (failures.length) throw new Error(`file previews failed: ${failures.join(", ")}`);
}
