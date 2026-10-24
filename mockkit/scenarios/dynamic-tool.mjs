import { S } from "../lib/ir.mjs";

// Dynamic tool calls (Codex `dynamicToolCall` items): client-side tools such as the node REPL (`node_repl.js`, T3 titles it from
// arguments.title) and a generic namespaced tool; one of them fails. Other adapters show plain tool calls.
export default {
  id: "dynamic-tool",
  title: "Dynamic tools",
  steps: () => [
    S.say("I'll measure the bundle with the JavaScript REPL and look up the retry policy in the docs tool.\n\n"),
    S.dynTool({
      namespace: "node_repl",
      tool: "js",
      input: { title: "Check bundle size", code: "const { size } = await fs.stat('dist/app.js');\nconsole.log(`dist/app.js: ${size} bytes`);" },
      output: "dist/app.js: 48213 bytes",
    }),
    S.dynTool({ namespace: "acme_docs", tool: "lookup", input: { query: "retry policy" }, output: "Retries use exponential backoff, at most 5 attempts." }),
    S.dynTool({ namespace: "acme_docs", tool: "lookup", input: { query: "circuit breaker" }, output: "No document matches 'circuit breaker'.", success: false }),
    S.say("\nThe bundle is 48,213 bytes, retries back off exponentially (max 5), and the docs have nothing on a circuit breaker."),
  ],
};
