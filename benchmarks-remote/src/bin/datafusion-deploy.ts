import { message, object, option, optional, string } from "@optique/core";
import { runSync } from "@optique/run";
import { Deployment, deploymentFlags } from "../lib/deployment";
import { publishingFlags, value } from "../lib/operations";
import { publishDatafusion } from "../lib/publishing";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...deploymentFlags,
  ...publishingFlags,
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
});

try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy DataFusion`,
  });
  if (Boolean(flags["worker-cpu"]) !== Boolean(flags["worker-memory"]))
    throw new Error("--worker-cpu and --worker-memory must be set together");
  const env = new Deployment("datafusion", flags);
  const settings: Record<string, string> = {
    "worker.artifact": value(
      flags,
      "worker-artifact",
      typeof flags["worker-artifact"] === "string"
        ? undefined
        : publishDatafusion(env),
    ),
    "worker.datasetBucket": env.output("datasetBucketName"),
    "worker.replicas": env.nodes,
    "worker.instanceType": env.instance,
    name: env.name,
  };
  if (flags["worker-cpu"]) {
    for (const kind of ["requests", "limits"]) {
      settings[`workerResources.${kind}.cpu`] = value(flags, "worker-cpu");
      settings[`workerResources.${kind}.memory`] = value(
        flags,
        "worker-memory",
      );
    }
  }
  env.deploy(settings);
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
