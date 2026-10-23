import { S } from "../lib/ir.mjs";

// Web search item (Codex webSearch) plus a commentary-phase message before the final answer.
// Other adapters show the search as a fetch tool call and ignore the phase.
export default {
  id: "web-search",
  title: "Web search",
  steps: () => [
    S.say("Let me look that up before answering.", { phase: "commentary" }),
    S.web("vite 8 config options"),
    S.web("vite 8 config options", { url: "https://vite.dev/config/" }),
    S.say("According to the Vite docs, `build.outDir` defaults to `dist` and `server.port` to `5173`."),
  ],
};
