import {
  engines,
  commonFlags,
  deploymentName,
  Environment,
} from "../lib/operations";
import {
  argument,
  choice,
  message,
  object,
  option,
  optional,
  string,
} from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  "deployment-name": optional(
    option("--deployment-name", string({ metavar: "VALUE" }), {
      description: message`Helm release name`,
    }),
  ),
  engine: argument(choice(engines), { description: message`Benchmark engine` }),
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Destroy an engine`,
  });
  const { engine } = flags;

  const name = deploymentName(engine, flags["deployment-name"]);
  const env = new Environment(flags);
  env.credentials();
  env.ensureKubeconfig();
  env.helm([
    "uninstall",
    name,
    "--namespace",
    `benchmark-${engine}`,
    "--ignore-not-found",
    "--wait",
    "--timeout",
    "10m",
  ]);
  console.log(
    `Destroyed ${name}; EKS Auto Mode will terminate its empty nodes`,
  );
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
