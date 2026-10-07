import { commonFlags, Environment } from "../lib/operations";
import { publishBallista } from "../lib/publishing";
import { message, object, option, optional, string } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  "target-dir": optional(
    option("--target-dir", string({ metavar: "VALUE" }), {
      description: message`Cargo target directory`,
    }),
  ),
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Publish Ballista binaries`,
  });

  console.log(JSON.stringify(publishBallista(new Environment(flags))));
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
