import { S } from "../lib/ir.mjs";

// Async question (Codex agentMessage delivery "async" + questions): the agent asks and the turn ENDS. T3 shows the question panel
// (answer or dismiss); the answer arrives later as a normal user message, handled by this scenario's `phase=answer`.
export default {
  id: "async-ask",
  title: "Async question",
  steps: (ctx) =>
    ctx.args.phase === "answer"
      ? [S.say(`Thanks. I recorded your answer and will plan the migration around it. You said: ${ctx.text.replace(/\s+/g, " ").slice(0, 300)}`)]
      : [
          S.say("I need two decisions before touching the schema.\n\n"),
          S.asyncAsk({
            text: "Two questions about the migration.",
            questions: [
              { title: "Which database should the migration target?", options: ["PostgreSQL", "SQLite"] },
              { title: "Run the migration automatically on deploy?", options: ["Yes", "No"] },
            ],
          }),
        ],
};
