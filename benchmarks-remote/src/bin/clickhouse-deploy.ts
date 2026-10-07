import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { Deployment, deploymentFlags } from "../lib/deployment";
import { errorMessage } from "../lib/filesystem";

const Options = object({ ...deploymentFlags });
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy Clickhouse`,
  });
  const env = new Deployment("clickhouse", flags);
  env.deploy({
    workerReplicas: env.nodes,
    workerInstanceType: env.instance,
  });
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
