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

  // The coordinator tracks query/task state across every worker and holds the full
  // EXPLAIN ANALYZE output in memory, so its heap must grow with the worker count or
  // it OOMs (JVM exits via -XX:+ExitOnOutOfMemoryError) once enough workers report back.
  const nodeCount = Number(env.nodes);
  const coordinatorHeapGb = Math.max(2, Math.floor((nodeCount + 5) / 6));
  const coordinatorMemoryOverheadGb = Math.max(
    1,
    Math.floor(coordinatorHeapGb / 5),
  );
  const coordinatorMemoryRequestGi = coordinatorHeapGb;
  const coordinatorMemoryLimitGi =
    coordinatorHeapGb + coordinatorMemoryOverheadGb;
  const coordinatorInstanceType =
    nodeCount <= 12
      ? env.output("coordinatorInstanceType")
      : coordinatorHeapGb <= 10
        ? "m6i.xlarge"
        : "m6i.2xlarge";

  // Workers get a fixed 17Gi pod (shared across engines via worker-resources.yaml), but the
  // default Trino heap (10G) only uses part of that budget. Beyond the default cluster size,
  // use more of the existing pod headroom so heavy joins (e.g. TPC-H q9) have more real
  // per-node query memory, not just a larger share of the same ceiling.
  const workerHeapGb = nodeCount <= 12 ? 10 : 13;
  const workerQueryMemoryPerNodeGb = nodeCount <= 12 ? 8 : 11;

  // Cluster-wide query memory is bounded by each worker's query.max-memory-per-node, so the
  // ceiling scales with the worker count. Keep the previously tuned 80GB at the default 12
  // workers, and leave an 8% skew margin under the per-node ceiling beyond that.
  const queryMaxMemoryGb =
    nodeCount <= 12
      ? 80
      : Math.floor((nodeCount * workerQueryMemoryPerNodeGb * 92) / 100);

  env.deploy({
    workerReplicas: env.nodes,
    workerInstanceType: env.instance,
    coordinatorInstanceType,
    coordinatorHeapGb: String(coordinatorHeapGb),
    coordinatorMemoryRequestGi: String(coordinatorMemoryRequestGi),
    coordinatorMemoryLimitGi: String(coordinatorMemoryLimitGi),
    workerHeapGb: String(workerHeapGb),
    workerQueryMemoryPerNodeGb: String(workerQueryMemoryPerNodeGb),
    queryMaxMemoryGb: String(queryMaxMemoryGb),
    region: env.region,
    datasetBucket: env.output("datasetBucketName"),
  });
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
