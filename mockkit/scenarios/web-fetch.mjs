import { S } from "../lib/ir.mjs";

// WebSearch then WebFetch (Claude tools; T3 `web_search` items: search patterns + result links, fetched page snippet).
// Codex shows the search as a webSearch item; the fetch flag is ignored there. ACP: fetch-kind tool calls.
export default {
  id: "web-fetch",
  title: "Web search + fetch",
  steps: () => [
    S.say("Let me search for the docs and read the page.\n\n"),
    S.web("vite build.outDir default", {
      results: [
        { title: "Build Options | Vite", url: "https://vite.dev/config/build-options.html" },
        { title: "Configuring Vite", url: "https://vite.dev/config/" },
      ],
    }),
    S.web("vite build.outDir default", {
      fetch: true,
      url: "https://vite.dev/config/build-options.html",
      results: [{ snippet: "# Build Options\n\nbuild.outDir: Specify the output directory (default: dist)." }],
    }),
    S.say("According to the fetched Vite docs, `build.outDir` defaults to `dist`."),
  ],
};
