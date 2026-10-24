import { S } from "../lib/ir.mjs";

// Provider notice (Claude system `informational` warning -> T3 system_notice row). Others: plain assistant line.
export default {
  id: "notice",
  title: "Provider notice",
  steps: () => [
    S.notice("Heads up: this mock session is running on a fallback model."),
    S.say("Continuing with the fallback model."),
  ],
};
