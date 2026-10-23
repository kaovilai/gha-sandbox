// S22 session resume (Claude): kill the Claude CLI process between two turns; T3 respawns it with `--resume=<session id>`
// and the mock restores the session (turn counter + history persisted under $MOCK_CONTROL_DIR/claude-sessions/), so turn 2
// still quotes turn 1. Proof = the UI text AND a `--resume=` line in the launcher's probes.log.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dumpPage, providerOf, sendPrompt, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") {
    console.log("FINDING: s22 is Claude-specific (CLI session resume); skipped for other providers");
    return;
  }
  await startSession(page, env);
  await sendPrompt(page, "First message before the CLI dies.");
  await page.getByText(/Mock agent, turn 1/).first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot("turn1");
  // session processes carry --session-id / --resume; capability probes and text generation do not
  const killed = spawnSync("pkill", ["-f", "-c", "t3-mock-claude.mjs.*--(session-id|resume)"], { encoding: "utf8" });
  console.log(`pkill session processes: exit=${killed.status} count=${killed.stdout.trim()}`);
  if (killed.status !== 0) throw new Error("no running Claude CLI session process to kill (is the mock the session binary?)");
  await page.waitForTimeout(2500);
  await shot("cli-killed");
  await sendPrompt(page, "Second message after the respawn.");
  try {
    await page.getByText(/Mock agent, turn 2/).first().waitFor({ timeout: 60_000 });
  } catch (e) {
    await dumpPage(page, "s22 no turn 2 after respawn");
    throw e;
  }
  await page.waitForTimeout(1500);
  await shot("turn2-resumed");
  const probes = readFileSync(join(env.MOCK_CONTROL_DIR, "probes.log"), "utf8");
  const resumes = probes.split("\n").filter((l) => /--resume[= ]/.test(l));
  console.log(`FINDING launcher lines with --resume: ${resumes.length}\n${resumes.map((l) => l.slice(0, 160)).join("\n")}`);
  if (resumes.length === 0) throw new Error("T3 never respawned the CLI with --resume (turn 2 may have come from a fresh session)");
  const text = await page.evaluate(() => document.body.innerText);
  if (!/Your previous message was: "First message before the CLI dies\./.test(text)) throw new Error("turn 2 did not see turn 1 history after the respawn");
}
