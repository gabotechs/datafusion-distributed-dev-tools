import {
  DEFAULT_BENCHMARK_INSTANCE_TYPE,
  DEFAULT_BENCHMARK_NODE_COUNT,
  MAX_BENCHMARK_NODES,
} from "./command.js";
import { BENCHMARK_ITERATIONS, BENCHMARK_WARMUP } from "./executor.js";
import {
  SUPPORTED_BENCHMARK_INSTANCES,
  SUPPORTED_BENCHMARK_INSTANCE_TYPES,
  benchmarkWorkerResources,
} from "./instance-types.js";
import { MAX_ACTIVE_JOBS_PER_REQUESTER, MAX_QUEUE_DEPTH } from "./limits.js";

const AVAILABLE_DATASETS = [
  "clickbench/0-100",
  "tpcds/sf1",
  "tpch/sf1",
  "tpch/sf10",
  "tpch/sf100",
] as const;

export function renderUsage(): string {
  const workload = `${BENCHMARK_WARMUP ? "1 warmup and " : ""}${BENCHMARK_ITERATIONS} measured iterations`;
  const datasets = AVAILABLE_DATASETS.map((dataset) => `\`${dataset}\``).join(
    ", ",
  );
  const instances = SUPPORTED_BENCHMARK_INSTANCE_TYPES.map((instanceType) => {
    const capacity = SUPPORTED_BENCHMARK_INSTANCES[instanceType];
    const resources = benchmarkWorkerResources(instanceType)!;
    return `| \`${instanceType}\` | ${capacity.vcpus} vCPU, ${capacity.memoryGiB} GiB | ${resources.cpu} vCPU, ${resources.memory} |`;
  }).join("\n");

  return `<details>
<summary>How to use the benchmark bot</summary>

Post a comment whose first non-empty line is:

\`benchmarks run <suite>/<variant>... [--instance-type <type>] [--nodes <count>] [--base main] [--config <key=value>]...\`

For example:

\`benchmarks run tpch/sf10 tpch/sf100 --instance-type m5.2xlarge --nodes 24 --base main --config distributed.collect_dynamic_filters=false\`

**Currently available datasets:** ${datasets}. Request one or more, without duplicates. The bot validates availability before provisioning and runs every query in each dataset.

| Option | Default | Supported values and behavior |
| --- | --- | --- |
| \`--instance-type <type>\` | \`${DEFAULT_BENCHMARK_INSTANCE_TYPE}\` | One of the supported instance types listed below, subject to availability within the cluster's availability zones and quota. |
| \`--nodes <count>\` | \`${DEFAULT_BENCHMARK_NODE_COUNT}\` | An integer from 1 to ${MAX_BENCHMARK_NODES}. The deployment uses one benchmark worker per node. |
| \`--base main\` | PR base | Compare against a snapshot of \`main\`; no other explicit base is supported. |
| \`--config <key=value>\` | none | Apply a safe DataFusion session setting to the PR head only. Repeat for distinct keys; spaces and shell syntax are not supported. |

**Supported instances and per-worker limits:**

| Instance type | EC2 capacity | Worker requests and limits |
| --- | ---: | ---: |
${instances}

Each node runs one worker. The worker allocation reserves 1 vCPU and 4 GiB for Kubernetes and system processes, then makes the rest of the selected instance available to the benchmark.

**Limits:** Only authorized users can enqueue jobs. Jobs run serially, the queue holds ${MAX_QUEUE_DEPTH} active jobs, and each requester may have ${MAX_ACTIVE_JOBS_PER_REQUESTER}. Query selection and iteration overrides are not supported; every query uses ${workload} for both revisions.

</details>`;
}

export function appendUsage(message: string): string {
  return `${message}\n\n${renderUsage()}`;
}
