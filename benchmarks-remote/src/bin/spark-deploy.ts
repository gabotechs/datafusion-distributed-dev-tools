import { message, object, option, optional, string } from "@optique/core";
import { runSync } from "@optique/run";
import { Deployment, deploymentFlags } from "../lib/deployment";
import { errorMessage } from "../lib/filesystem";
import { publishImage } from "../lib/publishing";

const Options = object({
  ...deploymentFlags,
  "spark-image": optional(
    option("--spark-image", string({ metavar: "VALUE" }), {
      description: message`Existing Spark image URI`,
    }),
  ),
});
async function main(): Promise<void> {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy Spark`,
  });
  const env = new Deployment("spark", flags);

  // The driver (the "http" container, which embeds the SparkSession) tracks query
  // planning and shuffle/task bookkeeping across every executor, so its heap must grow
  // with the worker count or it runs out of memory under a large cluster's query load.
  const nodeCount = Number(env.nodes);
  const driverHeapGb = Math.max(3, Math.floor((nodeCount + 5) / 6) + 1);
  const driverMemoryOverheadGb = Math.max(1, Math.floor(driverHeapGb / 5));
  const driverMemoryRequestGi = driverHeapGb;
  const driverMemoryLimitGi = driverHeapGb + driverMemoryOverheadGb;
  // The coordinator pod also runs the lightweight 2Gi Master container alongside the driver.
  const coordinatorInstanceType =
    nodeCount <= 12
      ? env.output("coordinatorInstanceType")
      : driverHeapGb <= 10
        ? "m6i.xlarge"
        : "m6i.2xlarge";

  env.deploy({
    workerReplicas: env.nodes,
    workerInstanceType: env.instance,
    coordinatorInstanceType,
    driverHeapGb: String(driverHeapGb),
    driverMemoryRequestGi: String(driverMemoryRequestGi),
    driverMemoryLimitGi: String(driverMemoryLimitGi),
    image: flags["spark-image"] ?? (await publishImage(env, "spark")),
  });
}
void main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
