import { S } from "../lib/ir.mjs";

// Default scenario (no [mock:..] tag): short deterministic reply; counts turns and quotes the prior prompt.
export default {
  id: "echo",
  title: "Mock echo",
  steps: (ctx) => {
    const prev = ctx.history.at(-1);
    // T3's cross-provider handoff (model switch mid-thread) sends its own internal summary prompt (thread/item uuids): never quote it.
    if (/^Context handoff \(/.test(ctx.text)) {
      return [S.say(`Mock agent, turn ${ctx.turn}. I picked up this thread from the previous provider and can continue from here.`)];
    }
    return [
      S.say(
        `Mock agent, turn ${ctx.turn}. You said: "${ctx.text.slice(0, 200)}".` +
          (prev ? ` Your previous message was: "${prev.slice(0, 120)}".` : " This is the first turn."),
      ),
    ];
  },
};
