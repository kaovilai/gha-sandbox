// S73 async question (Codex agentMessage delivery "async" + questions): the agent message carries two questions and the turn ENDS
// (no blocking request). T3 shows the question panel above the composer (answer or dismiss); the answers go back as an ordinary user
// message that starts a new turn, answered by the mock (`async-ask phase=answer`). Codex flavor only.
import { ask, bodyText, dumpPage, expectBody, expectText, expectVisible, nextScenario, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env }) {
  await startSession(page, env);
  await ask(page, env, "async-ask", "Plan the database migration.");
  await expectText(page, /Which database should the migration target\?/, "first async question in the panel", 60_000);
  await page.waitForTimeout(1200);
  const pending = await dumpPage(page, "s73 async question pending");
  console.log(`FINDING panel: q1=${/Which database/.test(pending.text)} q2=${/Run the migration automatically/.test(pending.text)} optionPostgres=${/PostgreSQL/.test(pending.text)} optionSqlite=${/SQLite/.test(pending.text)} dismiss=${/Dismiss|Skip|Not now/i.test(pending.text)} status=${JSON.stringify(pending.text.match(/^(Working|Running|Done|Idle|Waiting[^\n]*)$/m)?.[0] ?? null)}`);
  await shot("question-pending");
  // the turn is over (the question does not block it): the thread is not "Working"
  if (/^Working$/m.test(pending.text)) console.log("FINDING: thread still reads Working while the async question is pending");
  nextScenario(env, "async-ask", { phase: "answer" }); // the answer is a NEW turn
  const click = async (label) => {
    const el = page.getByText(label, { exact: false }).first();
    await expectVisible(page, el, `option ${label}`, 15_000);
    await el.click();
    await page.waitForTimeout(900);
  };
  await click("PostgreSQL");
  await shot("first-answered");
  if (/Run the migration automatically/.test(await bodyText(page))) {
    const yes = page.getByText(/^Yes$/).first();
    if (await yes.isVisible().catch(() => false)) {
      await yes.click();
      await page.waitForTimeout(900);
    }
  }
  // answering the LAST question submits (T3 shows one question at a time, "Question 1/2"); no extra submit control exists
  await expectText(page, /I recorded your answer and will plan the migration/, "agent reply after the async answer (a new turn)", 90_000);
  const m = await expectBody(page, /You said: ([^\n]*)/, "agent echoes the answer message T3 sent", 20_000);
  console.log(`FINDING answer message text T3 sent: ${JSON.stringify(m[1])}`);
  if (!/PostgreSQL/.test(m[1])) throw new Error(`assertion failed: the answer message does not carry the chosen option: ${m[1]}`);
  await page.waitForTimeout(1500);
  await shot("answered");
  await dumpPage(page, "s73 answered");
}
