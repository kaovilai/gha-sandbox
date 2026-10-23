// S09 approval-deny: Supervised mode, shell command needs approval, user clicks Decline, agent acknowledges.
// A marker file in dist/ proves the declined `rm -rf dist` never ran (checked on disk before and after).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, dumpPage, expectText, expectVisible, setRuntimeMode, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  const keep = join(env.MOCKKIT_WS, "dist/keep.txt");
  mkdirSync(join(env.MOCKKIT_WS, "dist"), { recursive: true });
  writeFileSync(keep, "must survive the declined command\n");
  // keep the marker out of the Changes counter
  appendFileSync(join(execFileSync("git", ["rev-parse", "--git-dir"], { cwd: env.MOCKKIT_WS, encoding: "utf8" }).trim().replace(/^(?!\/)/, `${env.MOCKKIT_WS}/`), "info/exclude"), "dist/\n");
  await startSession(page, env);
  await setRuntimeMode(page, /^Supervised/, { shot });
  await ask(page, env, "approval-deny", "Clean the build output.");
  const decline = page.getByRole("button", { name: /^Decline$/ }).first();
  try {
    await decline.waitFor({ state: "visible", timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s09 no decline button");
    throw e;
  }
  await expectVisible(page, page.getByRole("button", { name: /^Approve$/ }), "Approve button next to Decline");
  await expectText(page, /rm -rf dist/, "approval card shows the command 'rm -rf dist'");
  await page.waitForTimeout(800);
  if (!existsSync(keep)) throw new Error("assertion failed: dist/keep.txt vanished while the approval was pending");
  await shot("pending");
  await decline.click();
  await page.getByText(/Understood, I will leave/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  if (!existsSync(keep)) throw new Error("assertion failed: the declined command ran anyway (dist/keep.txt is gone)");
  await expectText(page, /leave `?dist`? untouched|leave dist untouched/, "agent acknowledges the declined command");
  await shot("declined");
  await dumpPage(page, "s09 declined");
}
