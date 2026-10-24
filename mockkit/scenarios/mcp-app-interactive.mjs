import { S } from "../lib/ir.mjs";

// Interactive MCP app (Codex): the HTML app has a script that talks to T3 over the MCP Apps bridge (postMessage JSON-RPC: ui/initialize,
// tools/call). T3 first asks the provider for the server's tools (mcpServerStatus/list, which carries `_meta.ui.visibility`) and only then
// forwards an allowed call as mcpServer/tool/call. `deploy_status` is app-callable and answers with a fresh counter on each click;
// `rotate_keys` is hidden from apps (visibility ["model"]) so T3 refuses the call ("tool-not-callable").
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 14px; background: #f6f8fb; color: #1d2733; }
  h1 { font-size: 15px; margin: 0 0 10px; }
  button { font: inherit; padding: 5px 12px; margin-right: 8px; border: 1px solid #9fb3c8; border-radius: 6px; background: #fff; cursor: pointer; }
  #status, #hidden { margin: 10px 0 0; padding: 8px 10px; background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; }
</style></head><body>
  <h1>Deploy board (mock MCP app, interactive)</h1>
  <div><button id="refresh">Refresh status</button><button id="rotate">Rotate keys</button></div>
  <div id="status">Initializing...</div>
  <div id="hidden">Hidden tool: not tried yet</div>
<script>
(function () {
  var nextId = 1;
  var pending = {};
  function send(msg) { msg.jsonrpc = "2.0"; window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      send({ id: id, method: method, params: params });
    });
  }
  function textOf(result) {
    var c = (result && result.content) || [];
    return c.map(function (b) { return b.text || ""; }).join(" ");
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "error")); else p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") document.getElementById("status").textContent = "Initial result: " + textOf(m.params);
    if (m.method === "ui/resource-teardown" && m.id !== undefined) send({ id: m.id, result: {} });
  });
  document.getElementById("refresh").addEventListener("click", function () {
    document.getElementById("status").textContent = "Calling deploy_status...";
    request("tools/call", { name: "deploy_status", arguments: { env: "staging" } }).then(
      function (r) { document.getElementById("status").textContent = "tools/call ok: " + textOf(r); },
      function (e) { document.getElementById("status").textContent = "tools/call failed: " + e.message; }
    );
  });
  document.getElementById("rotate").addEventListener("click", function () {
    document.getElementById("hidden").textContent = "Calling rotate_keys...";
    request("tools/call", { name: "rotate_keys", arguments: {} }).then(
      function (r) { document.getElementById("hidden").textContent = "rotate_keys ok: " + textOf(r); },
      function (e) { document.getElementById("hidden").textContent = "rotate_keys refused: " + e.message; }
    );
  });
  request("ui/initialize", { protocolVersion: "2026-01-26", appCapabilities: {}, appInfo: { name: "deploy-board", version: "1.0.0" } }).then(function () {
    send({ method: "ui/notifications/initialized", params: {} });
  });
})();
</script>
</body></html>`;

let calls = 0;

export default {
  id: "mcp-app-interactive",
  title: "Interactive MCP app",
  steps: () => [
    S.say("Opening the deploy board.\n\n"),
    S.mcpApp({
      server: "deploys",
      name: "deploy_board",
      title: "deploys.deploy_board",
      input: { env: "staging" },
      output: "Deploy board ready",
      html,
      tools: [
        {
          name: "deploy_status",
          title: "Deploy status",
          description: "Current deploy status of an environment",
          inputSchema: { type: "object", properties: { env: { type: "string" } } },
          visibility: ["model", "app"],
          result: (args) => `staging v2.14.${++calls} live, 3 pods healthy (env=${args.env ?? "staging"}, check #${calls})`,
        },
        { name: "rotate_keys", description: "Rotate signing keys (model only)", visibility: ["model"], result: "rotated" },
      ],
    }),
    S.say("The board is open: Refresh status calls the deploy_status tool through T3."),
  ],
};
