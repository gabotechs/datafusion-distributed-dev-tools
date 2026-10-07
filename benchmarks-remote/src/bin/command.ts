import {
  engines,
  commonFlags,
  Environment,
  workerSelector,
} from "../lib/operations";
import { argument, choice, message, object, string } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  engine: argument(choice(engines), { description: message`Benchmark engine` }),
  commandArgs: argument(string({ metavar: "COMMAND" }))
    .multiple()
    .nonEmpty(),
});
try {
  const { engine, commandArgs, ...flags } = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Run a command in an engine worker`,
  });

  const env = new Environment(flags);
  env.ensureKubeconfig();
  const pod = env.kubectl(
    [
      "get",
      "pods",
      "--namespace",
      `benchmark-${engine}`,
      "--selector",
      workerSelector(engine),
      "--field-selector",
      "status.phase=Running",
      "--output",
      "jsonpath={.items[0].metadata.name}",
    ],
    { capture: true },
  );
  if (!pod) throw new Error(`No running ${engine} worker pod`);
  env.kubectl([
    "exec",
    "--namespace",
    `benchmark-${engine}`,
    pod,
    "--",
    ...commandArgs,
  ]);
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
