import { commonFlags, Environment, publishingFlags } from "../lib/operations";
import { publishDatafusion } from "../lib/publishing";
import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  ...publishingFlags,
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Publish the DataFusion worker`,
  });

  console.log(publishDatafusion(new Environment(flags)));
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
