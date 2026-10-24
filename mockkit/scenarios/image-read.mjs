import { S } from "../lib/ir.mjs";

// Read on an image file: Claude returns the picture as an `image` block in the tool_result (T3 shows a workspace image preview under the
// Read row). Arg path=<file> (default assets/logo.png, created by the driver). Other adapters read it as text/binary.
export default {
  id: "image-read",
  title: "Read an image",
  steps: (ctx) => [
    S.say("Let me look at the logo.\n\n"),
    S.read(ctx.args.path ?? "assets/logo.png"),
    S.say("It is a small solid-colour PNG logo."),
  ],
};
