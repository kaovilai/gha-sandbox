// S24 git commit + push: agent edits files, UI Commit dialog with an auto-generated message (text-gen stub), then Push to a
// local bare remote. Verified outside the UI with `git log` / `git ls-remote`. The commit message's SOURCE is proven from the
// mock log: the subject equals the reply of a `textgen` entry (ACP prompt / Codex `exec`), which no other code path produces.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask, dumpPage, expectBody, expectText, startSession } from "../lib/ui.mjs";
import { must } from "../lib/ui-extra.mjs";

const STUB_SUBJECT = "Update files via mock agent"; // lib/textgen.mjs

// textgen entries of the mock log (one NDJSON line per text-generation reply) -> [{ agent, seq, t, json }]
function textgenReplies(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try {
      const rec = JSON.parse(line);
      if (rec.dir !== "textgen") continue;
      out.push({ agent: rec.agent, seq: rec.seq, t: rec.t, json: JSON.parse(rec.reply) });
    } catch {}
  }
  return out;
}

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Mock", GIT_AUTHOR_EMAIL: "mock@example.invalid", GIT_COMMITTER_NAME: "Mock", GIT_COMMITTER_EMAIL: "mock@example.invalid" } }).trim();

export default async function ({ page, shot, env }) {
  const ws = env.MOCKKIT_WS;
  const bare = join(env.MOCKKIT_ROOT, "remote.git");
  git(env.MOCKKIT_ROOT, "init", "-q", "--bare", "-b", "main", bare);
  git(ws, "config", "user.name", "Mock User"); // the runner has no git identity; T3 commits inside this repo
  git(ws, "config", "user.email", "mock@example.invalid");
  git(ws, "remote", "add", "origin", bare);
  git(ws, "push", "-q", "-u", "origin", "main");
  console.log(`remote head before: ${git(ws, "ls-remote", "origin", "main")}`);

  await startSession(page, env);
  await ask(page, env, "edit-file-diff", "Update the greeting helper and add a farewell helper.");
  await page.getByText(/Open the diff panel to review/).first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  await shot("edited");
  await dumpPage(page, "s24 edited");

  const opts = page.getByRole("button", { name: "Git action options" }).first();
  await must(page, opts, "Git action options button");
  await opts.click();
  await page.waitForTimeout(800);
  await shot("git-menu");
  await dumpPage(page, "s24 git menu");
  await page.getByRole("menuitem", { name: /^Commit$/ }).or(page.getByText(/^Commit$/)).last().click();
  await must(page, page.getByText("Commit message (optional)"), "commit dialog");
  await expectText(page, /Commit changes/, "commit dialog title");
  await expectBody(page, /src\/farewell\.ts/, "commit dialog lists src/farewell.ts");
  await expectBody(page, /src\/greeting\.ts/, "commit dialog lists src/greeting.ts");
  await page.waitForTimeout(1200);
  await shot("commit-dialog");
  await dumpPage(page, "s24 commit dialog");
  await page.getByRole("button", { name: /^Commit$/ }).last().click();
  // wait for the commit to exist
  const t0 = Date.now();
  let subject = "";
  while (Date.now() - t0 < 60_000) {
    subject = git(ws, "log", "-1", "--format=%s");
    if (subject !== "Add docs and assets" && subject !== "Initial commit") break;
    await page.waitForTimeout(1000);
  }
  console.log(`commit subject: ${subject}`);
  // proof of the message source: subject == stub reply, and the mock log has the text-generation call that produced it
  if (subject !== STUB_SUBJECT) throw new Error(`assertion failed: commit subject ${JSON.stringify(subject)} is not the text-gen stub's "${STUB_SUBJECT}"`);
  const gens = textgenReplies(env.MOCK_LOG);
  const hit = gens.find((g) => g.json.subject === subject);
  if (!hit) throw new Error(`assertion failed: no textgen entry with subject "${subject}" in ${env.MOCK_LOG} (${gens.length} textgen entries)`);
  console.log(`FINDING commit message source: textgen reply by ${hit.agent} (seq ${hit.seq}, ${hit.t}) = ${JSON.stringify(hit.json)}; ${gens.length} textgen entries in the mock log`);
  const stat = git(ws, "show", "--stat", "--format=%s", "HEAD");
  if (!/src\/farewell\.ts/.test(stat) || !/src\/greeting\.ts/.test(stat)) throw new Error(`assertion failed: commit does not contain both edited files:\n${stat}`);
  await page.waitForTimeout(2000);
  await shot("committed");
  await dumpPage(page, "s24 committed");

  // push
  const pushBtn = page.getByRole("button", { name: /^Push/ }).first();
  await must(page, pushBtn, "Push quick action");
  await pushBtn.click();
  await page.waitForTimeout(1500);
  const confirm = page.getByRole("button", { name: /Push to|Commit & push to/ }).first();
  if (await confirm.isVisible().catch(() => false)) {
    await shot("push-confirm");
    await confirm.click();
  }
  const t1 = Date.now();
  let remote = "";
  while (Date.now() - t1 < 60_000) {
    remote = git(ws, "ls-remote", "origin", "main");
    if (remote.split(/\s/)[0] === git(ws, "rev-parse", "HEAD")) break;
    await page.waitForTimeout(1000);
  }
  console.log(`remote head after: ${remote}; local HEAD: ${git(ws, "rev-parse", "HEAD")}`);
  console.log(`git log:\n${git(ws, "log", "--oneline", "-3")}`);
  await page.waitForTimeout(2000);
  await shot("pushed");
  await dumpPage(page, "s24 pushed");
  if (remote.split(/\s/)[0] !== git(ws, "rev-parse", "HEAD")) throw new Error("push did not reach the bare remote");
}
