import { S } from "../lib/ir.mjs";

// Longer todo list that advances through pending -> in_progress -> completed (ACP `plan` updates).
const ITEMS = [
  "Read package.json",
  "Find greeting call sites",
  "Rewrite greet() helper",
  "Add farewell() helper",
  "Update README usage",
  "Run the build",
];
const at = (done, active) =>
  ITEMS.map((content, i) => ({ content, priority: "medium", status: i < done ? "completed" : i === active ? "in_progress" : "pending" }));

export default {
  id: "todo",
  title: "Todo list progress",
  steps: (ctx) => {
    const gate = ctx.args.hold; // optional hold gate so a driver can freeze the nearly-done state
    return [
      S.say("Breaking this change into a checklist.\n\n"),
      S.plan(at(0, 0)),
      S.sleep(1800),
      S.plan(at(1, 1)),
      S.sleep(1800),
      S.plan(at(2, 2)),
      S.sleep(1800),
      S.plan(at(3, 3)),
      S.sleep(1800),
      S.plan(at(4, 4)),
      S.sleep(1800),
      S.plan(at(5, 5)),
      ...(gate ? [S.hold(gate)] : []),
      S.sleep(1500),
      S.plan(at(6, -1)),
      S.say("All six checklist items are complete."),
    ];
  },
};
