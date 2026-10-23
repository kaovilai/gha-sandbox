// Fresh pairing-token minter for the iOS live path. Zero deps.
//
// Upstream's showcase mints one pairing credential per environment BEFORE it launches the app and passes the
// URLs as launch args. Credentials are one-time with a 5 min TTL, so a slow cold start (Metro bundle on 3 vCPUs),
// an app relaunch, or an attempt the app abandons after 10 s (the credential may already be spent server-side)
// leaves the app retrying with dead tokens forever ("No environments connected"). The patched app
// (scripts/patch-showcase-ios-pairing.py) asks this server for a NEW credential on every attempt:
//   GET /pairing?port=<env server port>  -> text: http://127.0.0.1:<port>/#token=<fresh credential> (pooled, 2 h TTL)
//   GET /health                          -> "ok"
// Env: PAIRING_ENVS_FILE (json [{baseDir,port,label}] written by the patched showcase), PAIRING_PORT (8201),
// PAIRING_CWD (target checkout; cwd of `node apps/server/src/bin.ts auth pairing create`).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PAIRING_PORT ?? 8201);
const ENVS = process.env.PAIRING_ENVS_FILE ?? "/tmp/pairing-envs.json";
const CWD = process.env.PAIRING_CWD ?? process.cwd();

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[pairing ${ts()}] ${m}`);

export function parseCredential(output) {
  const a = output.indexOf("{");
  const b = output.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(`no JSON in: ${output.slice(0, 120)}`);
  const parsed = JSON.parse(output.slice(a, b + 1));
  if (typeof parsed.credential !== "string" || !parsed.credential) throw new Error("no credential in output");
  return parsed.credential;
}

export function buildUrl(port, credential) {
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.hash = new URLSearchParams([["token", credential]]).toString();
  return url.toString();
}

function mint(baseDir) {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      // --ttl 2h: credentials are minted ahead of use (a mint takes 20-100 s while Metro saturates 3 vCPUs)
      ["apps/server/src/bin.ts", "auth", "pairing", "create", "--base-dir", baseDir, "--ttl", "2h", "--json"],
      { cwd: CWD, env: { ...process.env, NO_COLOR: "1" }, timeout: 300_000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message} ${String(stderr).slice(0, 200)}`));
        try {
          resolve(parseCredential(String(stdout)));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

// per environment: a pool of ready credentials + at most one mint in flight (concurrent requests share it)
const state = new Map();
let minted = 0;
function envState(env) {
  let st = state.get(env.port);
  if (!st) state.set(env.port, (st = { pool: [], inflight: null }));
  return st;
}
function startMint(env) {
  const st = envState(env);
  if (st.inflight) return st.inflight;
  const t0 = Date.now();
  st.inflight = mint(env.baseDir)
    .then((credential) => {
      minted += 1;
      log(`minted #${minted} for ${env.label ?? env.port} in ${Date.now() - t0} ms`);
      st.pool.push(credential);
    })
    .catch((e) => log(`mint failed for ${env.label ?? env.port} after ${Date.now() - t0} ms: ${e.message}`))
    .finally(() => (st.inflight = null));
  return st.inflight;
}
function readEnvs() {
  try {
    return JSON.parse(readFileSync(ENVS, "utf8"));
  } catch {
    return null;
  }
}

// pre-mint one credential per environment as soon as the envs file exists (serial: do not add CPU spikes)
let prewarmed = false;
async function prewarm() {
  if (prewarmed) return;
  const envs = readEnvs();
  if (!envs) return;
  prewarmed = true;
  for (const env of envs) await startMint(env);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/health") return void res.end("ok");
  if (u.pathname !== "/pairing") {
    res.statusCode = 404;
    return void res.end("not found");
  }
  const port = Number(u.searchParams.get("port"));
  const envs = readEnvs();
  if (!envs) {
    log(`GET ${req.url} -> 503 (envs file not written yet)`);
    res.statusCode = 503;
    return void res.end("envs not ready");
  }
  const env = envs.find((e) => e.port === port);
  if (!env) {
    log(`GET ${req.url} -> 404 (no env on port ${port}; have ${envs.map((e) => e.port)})`);
    res.statusCode = 404;
    return void res.end("unknown port");
  }
  const st = envState(env);
  for (let i = 0; i < 3 && st.pool.length === 0; i++) await startMint(env);
  const credential = st.pool.shift();
  if (!credential) {
    res.statusCode = 500;
    return void res.end("mint failed");
  }
  log(`served ${env.label ?? port} (pool left ${st.pool.length})`);
  res.end(buildUrl(port, credential));
  if (st.pool.length === 0) void startMint(env); // keep one spare ready for the next attempt
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, "127.0.0.1", () => log(`listening :${PORT}, envs file ${ENVS}, cwd ${CWD}`));
  setInterval(() => void prewarm(), 2000);
}
