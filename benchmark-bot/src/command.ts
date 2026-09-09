export interface BenchmarkRequest {
  datasets: string[];
  instanceType: string;
  nodeCount: number;
  base?: "main";
  configs?: string[];
}

export type ParseResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "request"; request: BenchmarkRequest };

const DATASET = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]{0,19}\.[a-z0-9-]{1,20}$/;
const CONFIG = /^([a-zA-Z][a-zA-Z0-9_.]*)=([a-zA-Z0-9._-]+)$/;
export const MAX_BENCHMARK_NODES = 24;
export const DEFAULT_BENCHMARK_INSTANCE_TYPE = "c5n.2xlarge";
export const DEFAULT_BENCHMARK_NODE_COUNT = 12;

const USAGE =
  "Expected `benchmarks run <suite>/<variant>... [--instance-type <type>] [--nodes <count>] [--base main] [--config <key=value>]...`.";

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
  const datasets = words.slice(2, datasetEnd);
  const optionWords = words.slice(datasetEnd);
  if (datasets.length === 0 || optionWords.length % 2 !== 0) {
    return { kind: "invalid", message: USAGE };
  }
  for (const dataset of datasets) {
    if (!DATASET.test(dataset)) {
      return {
        kind: "invalid",
        message: `Invalid dataset \`${dataset}\`; expected a path such as \`tpch/sf1\`.`,
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
      !["--instance-type", "--nodes", "--base"].includes(option) ||
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
      ...(base === "main" ? { base } : {}),
      ...(configs.length === 0 ? {} : { configs }),
    },
  };
}
