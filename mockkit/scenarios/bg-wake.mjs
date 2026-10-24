import { S } from "../lib/ir.mjs";

// The agent's reply to T3's background-completion continuation message (what T3 sends when a background command finishes).
export default {
  id: "bg-wake",
  title: "Background wake",
  steps: (ctx) => {
    const first = ctx.text.split("\n")[0].slice(0, 160);
    return [S.say(`The background command finished, so I picked the work back up. T3 reported: "${first}".\n\nThe dev server exited cleanly; nothing else to do.`)];
  },
};
