import { S } from "../lib/ir.mjs";

// Skill / slash-command execution (Claude: a `$skill` mention or `/skill args` text; the CLI expands the skill's SKILL.md and the model
// follows it, here via the `Skill` tool + reading the SKILL.md). The claude adapter selects this scenario by itself when the user message
// ends in `/<name>` and <cwd>/.claude/skills/<name>/SKILL.md exists; `ctx.skill` = {name,args,description,path,body}.
// Other adapters run a plain tool call + the same text.
export default {
  id: "skill-run",
  title: "Run a skill",
  steps: (ctx) => {
    const sk = ctx.skill ?? { name: "summarize-repo", args: "", description: "Summarize the repository", path: ".claude/skills/summarize-repo/SKILL.md" };
    return [
      S.say(`Running the **${sk.name}** skill${sk.args ? ` with arguments "${sk.args}"` : ""}.\n\n`),
      S.skill(sk.name, { args: sk.args || undefined }),
      S.read(sk.path),
      S.sh("ls"),
      S.say(`The ${sk.name} skill finished${sk.description ? `: ${sk.description}` : ""}. The workspace has a \`src\` folder, a README and a package.json.`),
    ];
  },
};
