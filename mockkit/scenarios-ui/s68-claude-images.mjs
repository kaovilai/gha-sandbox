// S68 images (Claude): (a) an image attached in the composer is sent as a base64 `image` content block (user message); the mock decodes the PNG
// header and answers what it received (media type, pixel size, bytes) -> proof the bytes reached the CLI. (b) `Read` of a workspace PNG returns an
// `image` block in the tool_result; T3 shows an image preview under the Read row (viewedImagePath).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dumpPage, expandRows, expandWork, expectBody, expectText, nextScenario, providerOf, startSession, composerEditor } from "../lib/ui.mjs";
import { finding, makePng } from "../lib/ui-extra.mjs";

export default async function ({ page, shot, env }) {
  if (providerOf(env) !== "claude") return console.log("FINDING: s68 is Claude-specific (image content blocks); skipped for other providers");
  const png = makePng(64, 48, [34, 139, 230]);
  mkdirSync(join(env.MOCKKIT_WS, "assets"), { recursive: true });
  writeFileSync(join(env.MOCKKIT_WS, "assets", "logo.png"), png);
  const attach = join(env.MOCKKIT_ROOT ?? env.MOCKKIT_WS, "attached-photo.png");
  writeFileSync(attach, makePng(96, 72, [230, 120, 34]));
  await startSession(page, env);
  // (a) attach
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(attach);
  await page.waitForTimeout(1500);
  await shot("attached");
  if (!(await page.locator(`img[alt="attached-photo.png"]`).first().isVisible().catch(() => false))) throw new Error("assertion failed: attachment thumbnail not shown in the composer");
  nextScenario(env, "image-input");
  const ed = composerEditor(page);
  await ed.click();
  await ed.pressSequentially("What is in this picture?", { delay: 15 });
  await page.keyboard.press("Enter");
  await expectBody(page, /I received 1 image:[\s\S]*image\/png, 96x72 px/, "the CLI received the image block (PNG 96x72 decoded by the mock)", 60_000);
  await page.waitForTimeout(1500);
  await shot("image-answer");
  const a = await dumpPage(page, "s68 image answer");
  await finding("user message shows the attached image", async () => `img=${await page.locator("img").count()} text=${/What is in this picture/.test(a.text)}`);
  // (b) Read of an image file
  nextScenario(env, "image-read", { path: "assets/logo.png" });
  await ed.click();
  await ed.pressSequentially("Look at the logo file.", { delay: 15 });
  await page.keyboard.press("Enter");
  await expectText(page, /It is a small solid-colour PNG logo\./, "answer after the Read of the PNG", 60_000);
  await page.waitForTimeout(1500);
  await expandWork(page);
  await expandRows(page, { type: "dynamic" });
  await page.waitForTimeout(1500);
  const b = await dumpPage(page, "s68 read image");
  if ((await page.locator(`img[src*="logo.png"], img[alt*="logo"]`).count()) < 1) throw new Error("assertion failed: Read of logo.png shows no image preview row");
  await expectBody(page, /Read [^\n]*logo\.png/, "Read row for logo.png", 10_000);
  await shot("read-image-row");
}
