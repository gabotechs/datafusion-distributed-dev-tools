import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { Deployment, deploymentFlags } from "../lib/deployment";
import { errorMessage } from "../lib/filesystem";
import { publishingFlags } from "../lib/operations";
import { publishBallista } from "../lib/publishing";

const Options = object({
  ...deploymentFlags,
  "target-dir": publishingFlags["target-dir"],
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy Ballista`,
  });
  const env = new Deployment("ballista", flags);
  const artifacts = publishBallista(env);
  env.deploy({
    workerReplicas: env.nodes,
    workerInstanceType: env.instance,
    coordinatorInstanceType: env.output("coordinatorInstanceType"),
    datasetBucket: env.output("datasetBucketName"),
    "artifacts.scheduler": artifacts["ballista-scheduler"]!,
    "artifacts.executor": artifacts["ballista-executor"]!,
    "artifacts.http": artifacts["ballista-http"]!,
  });
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
