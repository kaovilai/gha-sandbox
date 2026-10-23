import { S } from "../lib/ir.mjs";

export default {
  id: "ask",
  title: "Clarifying question",
  steps: () => [
    S.say("Before I continue I have one question.\n\n"),
    S.ask({
      questions: [
        {
          id: "style",
          question: "Which code style should the mock follow?",
          options: [
            { label: "Strict (Recommended)", description: "Precise types and validation." },
            { label: "Flexible", description: "Looser shapes, faster iteration." },
          ],
        },
      ],
      then: (answers) => [S.say(`\nThanks, going with: ${JSON.stringify(Object.values(answers).flat())}.`)],
    }),
  ],
};
