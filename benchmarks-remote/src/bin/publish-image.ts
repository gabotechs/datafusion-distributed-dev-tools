import { commonFlags, Environment } from "../lib/operations";
import { publishImage } from "../lib/publishing";
import { argument, choice, message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  engine: argument(choice(["spark"]), {
    description: message`Benchmark engine`,
  }),
});
async function main(): Promise<void> {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Publish the Spark image`,
  });
  const { engine } = flags;

  console.log(await publishImage(new Environment(flags), engine));
}
void main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
