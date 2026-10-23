import { S } from "../lib/ir.mjs";

export default {
  id: "error-turn",
  title: "Failing turn",
  steps: () => [
    S.say("Starting the task...\n\n"),
    S.error("API error (status 400 Bad Request): invalid_request_error: mock failure injected by the error-turn scenario", -32603),
  ],
};
