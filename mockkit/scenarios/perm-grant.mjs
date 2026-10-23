import { S } from "../lib/ir.mjs";

// Extra-permission request (Codex item/permissions/requestApproval): the agent asks for filesystem write access
// beyond the sandbox, T3 shows an approval card with the reason; granting returns the same permission profile.
export default {
  id: "perm-grant",
  title: "Permission request",
  steps: () => [
    S.say("The build writes to `dist/`, which is outside my default writable set. Requesting access.\n\n"),
    S.grant({
      reason: "Write build output to dist/",
      write: ["dist"],
      onAllow: [S.fsWrite("dist/build.log", "build ok\n"), S.say("\nGranted: wrote `dist/build.log`.")],
      onReject: [S.say("\nUnderstood, skipping the build output.")],
    }),
  ],
};
