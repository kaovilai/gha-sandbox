import { S } from "../lib/ir.mjs";

export default {
  id: "plan",
  title: "Plan / todo list",
  steps: () => [
    S.plan([
      { content: "Inspect package.json", priority: "medium", status: "in_progress" },
      { content: "Update greeting helper", priority: "medium", status: "pending" },
      { content: "Report completion", priority: "medium", status: "pending" },
    ]),
    S.sleep(800),
    S.plan([
      { content: "Inspect package.json", priority: "medium", status: "completed" },
      { content: "Update greeting helper", priority: "medium", status: "in_progress" },
      { content: "Report completion", priority: "medium", status: "pending" },
    ]),
    S.say("Plan tracked above; two of three steps are underway."),
  ],
};
