// node --test mockkit/test  (no T3 needed). iOS live pairing helpers: fresh-credential server + showcase patch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { buildUrl, parseCredential } from "../../scripts/ios-pairing-server.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "../../scripts");

test("parseCredential tolerates log noise around the JSON and rejects junk", () => {
  assert.equal(parseCredential('warn x\n{"credential":"abc123","expiresAt":"z"}\n'), "abc123");
  assert.throws(() => parseCredential("no json here"));
  assert.throws(() => parseCredential('{"nope":1}'));
});

test("buildUrl puts the token in the hash on 127.0.0.1", () => {
  assert.equal(buildUrl(4936, "t k"), "http://127.0.0.1:4936/#token=t+k");
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test("pairing server mints a NEW credential on every request, 404s unknown ports, 503s before envs file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pairing-"));
  mkdirSync(join(dir, "apps/server/src"), { recursive: true });
  // fake `bin.ts auth pairing create --base-dir X --json`: counter file makes each credential unique
  writeFileSync(
    join(dir, "apps/server/src/bin.ts"),
    `import fs from "node:fs";const f=${JSON.stringify(join(dir, "n"))};const n=(fs.existsSync(f)?+fs.readFileSync(f,"utf8"):0)+1;fs.writeFileSync(f,String(n));console.log(JSON.stringify({credential:"cred"+n+"-"+process.argv.at(-2)}));\n`,
  );
  const envsFile = join(dir, "envs.json");
  const port = 18200 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [join(scripts, "ios-pairing-server.mjs")], {
    env: { ...process.env, PAIRING_PORT: String(port), PAIRING_ENVS_FILE: envsFile, PAIRING_CWD: dir },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i++) {
      const ok = await get(port, "/health").catch(() => null);
      if (ok?.body === "ok") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await get(port, "/pairing?port=4936")).status, 503);
    writeFileSync(envsFile, JSON.stringify([{ baseDir: "/b/one", port: 4936, label: "One" }]));
    const a = await get(port, "/pairing?port=4936");
    const b = await get(port, "/pairing?port=4936");
    assert.equal(a.status, 200);
    assert.match(a.body, /^http:\/\/127\.0\.0\.1:4936\/#token=cred1-/);
    assert.notEqual(a.body, b.body, "second request must carry a different credential");
    assert.equal((await get(port, "/pairing?port=1")).status, 404);
  } finally {
    child.kill();
  }
});

test("patch-showcase-ios-pairing.py patches anchors and refuses when they are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "patch-"));
  const showcase = join(dir, "mobile-showcase.ts");
  const coord = join(dir, "Coordinator.tsx");
  writeFileSync(showcase, "x\n    for (const capture of captures) {\n      const pairingHost = 1;\n");
  writeFileSync(
    coord,
    [
      'import { useConnectionController } from "../connection/useConnectionController";',
      'const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";',
      "          const paired = await retryShowcaseOperation(",
      "            async () => AsyncResult.isSuccess(await connectPairingUrl(pairingUrl)),",
      "            { isCancelled: () => cancelled },",
      "          );",
      "  const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);",
      "",
    ].join("\n"),
  );
  const py = join(scripts, "patch-showcase-ios-pairing.py");
  const r = spawnSync("python3", ["-I", py, showcase, coord], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(showcase, "utf8"), /PAIRING_ENVS_FILE/);
  const c = readFileSync(coord, "utf8");
  assert.match(c, /ghaFreshPairingUrl\(pairingUrl\)/);
  assert.match(c, /attemptTimeoutMs: 120_000/);
  assert.match(c, /\[gha-fixture\]/);
  assert.match(c, /\[gha-session\]/);
  // second run: anchors are gone -> non-zero exit, so CI prints WARN
  const again = spawnSync("python3", ["-I", py, showcase, coord], { encoding: "utf8" });
  assert.notEqual(again.status, 0);
});
