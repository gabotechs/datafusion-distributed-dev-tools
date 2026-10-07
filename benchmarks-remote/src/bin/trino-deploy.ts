import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { Deployment, deploymentFlags } from "../lib/deployment";
import { errorMessage } from "../lib/filesystem";

const Options = object({ ...deploymentFlags });
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy Trino`,
  });
  const env = new Deployment("trino", flags);
  env.deploy({
    workerReplicas: env.nodes,
    workerInstanceType: env.instance,
    coordinatorInstanceType: env.output("coordinatorInstanceType"),
    region: env.region,
    datasetBucket: env.output("datasetBucketName"),
  });
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
