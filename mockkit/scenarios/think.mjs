import { S } from "../lib/ir.mjs";

export default {
  id: "think",
  title: "Reasoning then answer",
  steps: () => [
    S.think("The user wants a short explanation. First I should consider the two options, compare their trade-offs, and then pick the simpler one.", { chunk: 3, paceMs: 60 }),
    S.say("After weighing both options, the simpler approach wins: keep one scenario engine and thin protocol adapters.", { chunk: 3, paceMs: 50 }),
  ],
};
