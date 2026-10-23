import { S } from "../lib/ir.mjs";

export default {
  id: "shell",
  title: "Shell command output",
  steps: () => [
    S.say("Running a build-like command.\n\n"),
    S.sh(
      `i=1; while [ $i -le 6 ]; do printf '\\033[32mstep %s/6\\033[0m: compiling module-%s\\n' $i $i; sleep 0.4; i=$((i+1)); done; echo 'build finished'`,
      { title: "npm run build" },
    ),
    S.say("\nThe command finished successfully."),
  ],
};
