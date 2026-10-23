import { S } from "../lib/ir.mjs";

export default {
  id: "tool-read",
  title: "Read and search tools",
  steps: () => [
    S.say("Let me look at the project files first.\n\n"),
    S.read("README.md"),
    S.read("package.json"),
    S.tool({ kind: "search", title: 'Search for "greet" in src/', input: { pattern: "greet", path: "src" }, output: "src/greeting.ts:1:export function greet(name: string): string {" }),
    S.say("\nThe project is a tiny TypeScript package with a single `greet` helper in `src/greeting.ts`."),
  ],
};
