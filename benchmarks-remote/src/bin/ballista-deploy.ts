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

  // The scheduler tracks the DAG/task state for every executor, and the http server
  // aggregates query results, so both need more memory as the executor count grows (the
  // same failure mode hit the Trino coordinator and the Spark driver at this cluster size).
  const nodeCount = Number(env.nodes);
  const coordinatorContainerLimitGi = Math.max(
    2,
    Math.floor((nodeCount + 5) / 6) + 1,
  );
  const coordinatorContainerRequestGi = Math.max(
    1,
    coordinatorContainerLimitGi - 1,
  );
  const combinedCoordinatorMemoryGi = coordinatorContainerLimitGi * 2;
  const coordinatorInstanceType =
    nodeCount <= 12
      ? env.output("coordinatorInstanceType")
      : combinedCoordinatorMemoryGi <= 10
        ? "m6i.xlarge"
        : "m6i.2xlarge";

  env.deploy({
    workerReplicas: env.nodes,
    workerInstanceType: env.instance,
    coordinatorInstanceType,
    coordinatorContainerRequestGi: String(coordinatorContainerRequestGi),
    coordinatorContainerLimitGi: String(coordinatorContainerLimitGi),
    datasetBucket: env.output("datasetBucketName"),
    "artifacts.scheduler": artifacts["ballista-scheduler"]!,
    "artifacts.executor": artifacts["ballista-executor"]!,
    "artifacts.http": artifacts["ballista-http"]!,
  });
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
