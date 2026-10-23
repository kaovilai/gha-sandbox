import { S } from "../lib/ir.mjs";

// REAL fs writes in the session cwd (the workspace seeded by mockkit/seed/workspace.sh) so git diff /
// checkpoint capture are real. Expects src/greeting.ts to exist (gets modified); creates src/farewell.ts.
export default {
  id: "edit-file-diff",
  title: "Edit files with a diff",
  steps: () => [
    S.say("I'll update the greeting helper and add a farewell helper.\n\n"),
    S.read("src/greeting.ts"),
    S.fsWrite(
      "src/greeting.ts",
      `export function greet(name: string): string {
  const who = name.trim() || "world";
  return \`Hello, \${who}! Welcome aboard.\`;
}
`,
    ),
    S.fsWrite(
      "src/farewell.ts",
      `export function farewell(name: string): string {
  return \`Goodbye, \${name.trim() || "friend"}!\`;
}
`,
    ),
    S.sh("git status --short"),
    S.say("\nDone: `greet` now adds a welcome, and `farewell` is new. Open the diff panel to review."),
  ],
};
