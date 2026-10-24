// DK02 settings via the NATIVE application menu accelerator (CmdOrCtrl+, -> main process -> menu-action IPC -> renderer route).
// Desktop-only: the web build has no application menu. shot = real desktop capture.
import { providerOf, startSession } from "../lib/ui.mjs";

export default async function ({ page, shot, env, native }) {
  await startSession(page, env);
  await native.key("ctrl+comma", { settle: 1500 });
  const reached = await page.waitForURL(/\/settings/, { timeout: 15_000 }).then(() => true, () => false);
  console.log(`FINDING ctrl+comma reached /settings via native accelerator: ${reached} (url=${page.url().replace(/[?#].*/, "")})`);
  if (!reached) {
    // fall back to in-app navigation so the settings stills still exist; recorded as a finding above
    await page.goto(new URL("/settings/general", page.url()).href).catch(() => {});
  }
  await page.getByText(/General|Appearance|Providers/).first().waitFor({ timeout: 30_000 });
  await native.sleep(1200);
  await shot("settings-general");
  const nav = async (label, name) => {
    const link = page.getByRole("link", { name: label }).or(page.getByRole("button", { name: label })).first();
    if (!(await link.isVisible().catch(() => false))) return console.log(`FINDING settings nav "${label}" not visible`);
    await link.click();
    await native.sleep(1500);
    await shot(name);
  };
  await nav(/^Providers$/, "settings-providers");
  // Claude/Codex runs: also show the detail pane of the running provider (the list opens on the first row, Codex) + its status line
  const prov = providerOf(env);
  if (prov !== "grok") {
    const name = prov === "claude" ? "Claude" : "Codex";
    const sel = page.getByRole("button", { name: new RegExp(`^Select ${name}$`) }).first();
    if (await sel.click({ timeout: 5000 }).then(() => true, () => false)) {
      await native.sleep(1200);
      console.log(`FINDING providers detail pane selected: ${name}; Authenticated visible: ${await page.getByText(/Authenticated/).first().isVisible().catch(() => false)}`);
      await shot(`settings-providers-${prov}`);
    } else console.log(`FINDING no \`Select ${name}\` button on the Providers page`);
  }
  await nav(/^Keybindings$/, "settings-keybindings");
}
