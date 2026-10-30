import {
  SUPPORTED_BENCHMARK_INSTANCE_TYPES,
  benchmarkWorkerResources,
  type SupportedBenchmarkInstanceType,
} from "./instance-types.js";

export interface BenchmarkRequest {
  datasets: string[];
  instanceType: string;
  nodeCount: number;
  iterations: number;
  base?: "main";
  configs?: string[];
}

export type ParseResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "request"; request: BenchmarkRequest };

const DATASET_SEGMENT = "[a-zA-Z0-9._=-]+";
const DATASET = new RegExp(`^${DATASET_SEGMENT}(?:/${DATASET_SEGMENT})+$`);
const DATASET_EXAMPLE =
  "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false";

// Short names used before datasets moved to the parameter-encoded path layout, mapped to
// their current equivalent so pre-existing comments and habits keep working.
const DATASET_ALIASES: ReadonlyMap<string, string> = new Map([
  [
    "tpch/sf1",
    "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
  ],
  [
    "tpch/sf10",
    "tpch_parquet/scale_factor=10/max_file_size=134217728/dictionary=pages/sorted=false",
  ],
  [
    "tpch/sf100",
    "tpch_parquet/scale_factor=100/max_file_size=134217728/dictionary=pages/sorted=false",
  ],
  [
    "tpcds/sf1",
    "tpcds_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false",
  ],
  [
    "tpcds/sf10",
    "tpcds_parquet/scale_factor=10/max_file_size=134217728/dictionary=pages/sorted=false",
  ],
  [
    "tpcds/sf100",
    "tpcds_parquet/scale_factor=100/max_file_size=134217728/dictionary=pages/sorted=false",
  ],
  [
    "clickbench/0-100",
    "clickbench_parquet/partition_start=0/partition_end=100",
  ],
]);

const INSTANCE_TYPE = /^[a-z][a-z0-9-]{0,19}\.[a-z0-9-]{1,20}$/;
const CONFIG = /^([a-zA-Z][a-zA-Z0-9_.]*)=([a-zA-Z0-9._-]+)$/;
export const MAX_BENCHMARK_NODES = 60;
export const DEFAULT_BENCHMARK_INSTANCE_TYPE: SupportedBenchmarkInstanceType =
  "c5n.4xlarge";
export const DEFAULT_BENCHMARK_NODE_COUNT = 12;
export const DEFAULT_BENCHMARK_ITERATIONS = 5;

const USAGE =
  "Expected `benchmarks run <dataset>... [--instance-type <type>] [--nodes <count>] [--iterations <count>] [--base main] [--config <key=value>]...`.";

// Only checks dataset path syntax and resolves legacy aliases; the caller checks each
// resolved dataset against the foundation's dataset bucket (see dataset-availability.ts).
export function parseComment(body: string): ParseResult {
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) {
    return { kind: "none" };
  }

  const words = line.split(/\s+/);
  if (words[0] !== "benchmarks" || words[1] !== "run") {
    return { kind: "none" };
  }
  const firstOption = words.findIndex(
    (word, index) => index >= 2 && word.startsWith("--"),
  );
  const datasetEnd = firstOption === -1 ? words.length : firstOption;
  const datasets = words
    .slice(2, datasetEnd)
    .map((dataset) => DATASET_ALIASES.get(dataset) ?? dataset);
  const optionWords = words.slice(datasetEnd);
  if (datasets.length === 0 || optionWords.length % 2 !== 0) {
    return { kind: "invalid", message: USAGE };
  }
  for (const dataset of datasets) {
    if (!DATASET.test(dataset)) {
      return {
        kind: "invalid",
        message: `Invalid dataset \`${dataset}\`; expected a path such as \`${DATASET_EXAMPLE}\`.`,
      };
    }
  }
  if (new Set(datasets).size !== datasets.length) {
    return {
      kind: "invalid",
      message: "Each dataset may be requested only once.",
    };
  }
  const options = new Map<string, string>();
  const configs: string[] = [];
  const configNames = new Set<string>();
  for (let index = 0; index < optionWords.length; index += 2) {
    const option = optionWords[index]!;
    const value = optionWords[index + 1]!;
    if (option === "--config") {
      const match = CONFIG.exec(value);
      if (!match) {
        return {
          kind: "invalid",
          message: `Invalid config \`${value}\`; expected a safe \`key=value\` token.`,
        };
      }
      const name = match[1]!;
      if (configNames.has(name)) {
        return {
          kind: "invalid",
          message: `Config \`${name}\` may be specified only once.`,
        };
      }
      configNames.add(name);
      configs.push(value);
      continue;
    }
    if (
      !["--instance-type", "--nodes", "--iterations", "--base"].includes(
        option,
      ) ||
      options.has(option)
    ) {
      return { kind: "invalid", message: USAGE };
    }
    options.set(option, value);
  }
  const instanceType =
    options.get("--instance-type") ?? DEFAULT_BENCHMARK_INSTANCE_TYPE;
  if (!INSTANCE_TYPE.test(instanceType)) {
    return {
      kind: "invalid",
      message: `Invalid instance type \`${instanceType}\`.`,
    };
  }
  if (!benchmarkWorkerResources(instanceType)) {
    return {
      kind: "invalid",
      message: `Unsupported instance type \`${instanceType}\`; expected one of ${SUPPORTED_BENCHMARK_INSTANCE_TYPES.map((value) => `\`${value}\``).join(", ")}.`,
    };
  }
  const nodeCountText =
    options.get("--nodes") ?? String(DEFAULT_BENCHMARK_NODE_COUNT);
  const nodeCount = Number(nodeCountText);
  if (
    !/^[1-9][0-9]*$/.test(nodeCountText) ||
    !Number.isSafeInteger(nodeCount) ||
    nodeCount > MAX_BENCHMARK_NODES
  ) {
    return {
      kind: "invalid",
      message: `Invalid node count \`${nodeCountText}\`; expected an integer from 1 to ${MAX_BENCHMARK_NODES}.`,
    };
  }
  const iterationsText =
    options.get("--iterations") ?? String(DEFAULT_BENCHMARK_ITERATIONS);
  const iterations = Number(iterationsText);
  if (
    !/^[1-9][0-9]*$/.test(iterationsText) ||
    !Number.isSafeInteger(iterations)
  ) {
    return {
      kind: "invalid",
      message: `Invalid iteration count \`${iterationsText}\`; expected a positive safe integer.`,
    };
  }
  const base = options.get("--base");
  if (base !== undefined && base !== "main") {
    return {
      kind: "invalid",
      message: `Invalid base \`${base}\`; only \`main\` is supported.`,
    };
  }
  return {
    kind: "request",
    request: {
      datasets,
      instanceType,
      nodeCount,
      iterations,
      ...(base === "main" ? { base } : {}),
      ...(configs.length === 0 ? {} : { configs }),
    },
  };
}
