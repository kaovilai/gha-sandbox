// Caching front for Metro's dev-client manifest endpoint.
//
// On 3-vCPU CI runners Metro takes 7-25 s to answer the manifest request, but the Expo dev
// launcher gives up after 10 s ("There was a problem loading the project"). This proxy fetches
// the manifest patiently in the background and serves the cached copy instantly; every other
// request (bundles, assets, HMR websocket) is passed straight through to Metro.
import http from "node:http";
import net from "node:net";

const UPSTREAM = { host: "127.0.0.1", port: Number(process.env.UPSTREAM_PORT ?? 8199) };
const PORT = Number(process.env.PROXY_PORT ?? 8200);
const QUERY =
  process.env.MANIFEST_QUERY ?? "disableOnboarding=1&disableFab=1&disableAutoLaunch=1";
const REFRESH_MS = Number(process.env.REFRESH_MS ?? 90_000);

let cached = null;

function fetchManifest() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...UPSTREAM,
        path: `/?${QUERY}`,
        method: "GET",
        headers: {
          host: `127.0.0.1:${PORT}`, // manifest URLs must point back at the proxy
          "expo-platform": "ios",
          "expo-api-version": "1",
          accept: "application/expo+json,application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.setTimeout(180_000, () => req.destroy(new Error("manifest fetch timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function warmLoop() {
  for (;;) {
    const started = Date.now();
    try {
      const r = await fetchManifest();
      if (r.status === 200 && r.body.length > 0) {
        cached = r;
        console.log(`manifest cached: ${r.body.length} bytes in ${Date.now() - started} ms`);
      } else {
        console.log(`manifest fetch status ${r.status}`);
      }
    } catch (error) {
      console.log(`manifest fetch failed: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, cached ? REFRESH_MS : 3_000));
  }
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  console.log(`REQ ${req.method} ${(req.url ?? "").slice(0, 110)} ua=${(req.headers["user-agent"] ?? "").slice(0, 40)}`);
  res.on("close", () => console.log(`CLOSE ${req.method} ${(req.url ?? "").slice(0, 60)} after ${Date.now() - t0}ms`));
  res.on("finish", () =>
    console.log(`${req.method} ${(req.url ?? "").slice(0, 110)} -> ${res.statusCode} ${Date.now() - t0}ms`),
  );
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
    const deadline = Date.now() + 120_000;
    while (!cached && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    if (cached) {
      const headers = { ...cached.headers, "content-length": String(cached.body.length) };
      delete headers["transfer-encoding"];
      res.writeHead(cached.status, headers);
      res.end(req.method === "HEAD" ? undefined : cached.body);
      return;
    }
  }
  const upstream = http.request(
    { ...UPSTREAM, path: req.url, method: req.method, headers: req.headers },
    (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      ures.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(upstream);
});

// HMR / debugger websockets: tunnel raw bytes.
server.on("upgrade", (req, socket, head) => {
  console.log(`UPGRADE ${req.url}`);
  const up = net.connect(UPSTREAM.port, UPSTREAM.host, () => {
    const headerLines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`);
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, "127.0.0.1", () => console.log(`manifest proxy :${PORT} -> :${UPSTREAM.port}`));
warmLoop();
