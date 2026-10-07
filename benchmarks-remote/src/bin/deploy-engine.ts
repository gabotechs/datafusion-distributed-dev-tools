import path from "node:path";
import {
  engines,
  deploymentName,
  remoteRoot,
  value,
  commonFlags,
  Environment,
  publishingFlags,
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
import {
  publishBallista,
  publishDatafusion,
  publishImage,
} from "../lib/publishing";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  ...publishingFlags,
  "deployment-name": optional(
    option("--deployment-name", string({ metavar: "VALUE" }), {
      description: message`Helm release name`,
    }),
  ),
  nodes: optional(
    option("--nodes", string({ metavar: "VALUE" }), {
      description: message`Worker count`,
    }),
  ),
  "instance-type": optional(
    option("--instance-type", string({ metavar: "VALUE" }), {
      description: message`Worker instance type`,
    }),
  ),
  "worker-cpu": optional(
    option("--worker-cpu", string({ metavar: "VALUE" }), {
      description: message`DataFusion worker CPU`,
    }),
  ),
  "worker-memory": optional(
    option("--worker-memory", string({ metavar: "VALUE" }), {
      description: message`DataFusion worker memory`,
    }),
  ),
  "worker-artifact": optional(
    option("--worker-artifact", string({ metavar: "VALUE" }), {
      description: message`Existing DataFusion worker S3 URI`,
    }),
  ),
  "spark-image": optional(
    option("--spark-image", string({ metavar: "VALUE" }), {
      description: message`Existing Spark image URI`,
    }),
  ),
  engine: argument(choice(engines), { description: message`Benchmark engine` }),
});
async function main(): Promise<void> {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy an engine`,
  });
  const { engine } = flags;

  const env = new Environment(flags);
  const name = deploymentName(engine, flags["deployment-name"]);
  const nodes = value(
    env.flags,
    "nodes",
    env.flags.nodes ? undefined : env.output("benchmarkNodeCount"),
  );
  if (!Number.isSafeInteger(Number(nodes)) || Number(nodes) <= 0)
    throw new Error("--nodes must be a positive integer");
  if (Boolean(env.flags["worker-cpu"]) !== Boolean(env.flags["worker-memory"]))
    throw new Error("--worker-cpu and --worker-memory must be set together");
  env.credentials();
  env.ensureKubeconfig();
  const bucket = env.output("datasetBucketName");
  const instance = value(
    env.flags,
    "instance-type",
    env.flags["instance-type"]
      ? undefined
      : env.output("benchmarkInstanceType"),
  );
  const settings: Record<string, string> = {};
  if (engine === "datafusion") {
    if (env.flags["worker-cpu"]) {
      for (const kind of ["requests", "limits"]) {
        settings[`workerResources.${kind}.cpu`] = value(
          env.flags,
          "worker-cpu",
        );
        settings[`workerResources.${kind}.memory`] = value(
          env.flags,
          "worker-memory",
        );
      }
    }
    settings["worker.artifact"] = value(
      env.flags,
      "worker-artifact",
      typeof env.flags["worker-artifact"] === "string"
        ? undefined
        : publishDatafusion(env),
    );
    settings["worker.datasetBucket"] = bucket;
    settings["worker.replicas"] = nodes;
    settings["worker.instanceType"] = instance;
    settings.name = name;
  } else {
    settings.workerReplicas = nodes;
    settings.workerInstanceType = instance;
    if (engine !== "clickhouse")
      settings.coordinatorInstanceType = env.output("coordinatorInstanceType");
    if (engine === "trino") {
      settings.region = env.region;
      settings.datasetBucket = bucket;
    }
    if (engine === "spark")
      settings.image =
        typeof env.flags["spark-image"] === "string"
          ? env.flags["spark-image"]
          : await publishImage(env, engine);
    if (engine === "ballista") {
      const artifacts = publishBallista(env);
      settings.datasetBucket = bucket;
      settings["artifacts.scheduler"] = artifacts["ballista-scheduler"]!;
      settings["artifacts.executor"] = artifacts["ballista-executor"]!;
      settings["artifacts.http"] = artifacts["ballista-http"]!;
    }
  }
  env.helm([
    "upgrade",
    "--install",
    name,
    path.join(remoteRoot, "k8s", engine),
    "--namespace",
    `benchmark-${engine}`,
    "--values",
    path.join(remoteRoot, "k8s/worker-resources.yaml"),
    "--rollback-on-failure",
    "--cleanup-on-fail",
    "--wait",
    "--timeout",
    "25m",
    ...Object.entries(settings).flatMap(([key, value]) => [
      "--set-string",
      `${key}=${value}`,
    ]),
  ]);
  console.log(
    `Deployed ${name}; it will remain running until npm run ${engine}-destroy`,
  );
}
void main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
