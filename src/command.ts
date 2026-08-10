export interface BenchmarkRequest {
  dataset: string;
  instanceType: string;
  nodeCount: number;
}

export type ParseResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "request"; request: BenchmarkRequest };

const DATASET = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const INSTANCE_TYPE = /^[a-z][a-z0-9-]{0,19}\.[a-z0-9-]{1,20}$/;
export const MAX_BENCHMARK_NODES = 24;

const USAGE =
  "Expected `benchmarks run <suite>/<variant> --instance-type <type> --nodes <count>`.";

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
  if (words.length !== 7 || !words[2]) {
    return { kind: "invalid", message: USAGE };
  }
  if (!DATASET.test(words[2])) {
    return {
      kind: "invalid",
      message: `Invalid dataset \`${words[2]}\`; expected a path such as \`tpch/sf1\`.`,
    };
  }
  const options = new Map<string, string>();
  for (let index = 3; index < words.length; index += 2) {
    const option = words[index]!;
    const value = words[index + 1]!;
    if (!option.startsWith("--") || options.has(option)) {
      return { kind: "invalid", message: USAGE };
    }
    options.set(option, value);
  }
  if (
    options.size !== 2 ||
    !options.has("--instance-type") ||
    !options.has("--nodes")
  ) {
    return { kind: "invalid", message: USAGE };
  }
  const instanceType = options.get("--instance-type")!;
  if (!INSTANCE_TYPE.test(instanceType)) {
    return {
      kind: "invalid",
      message: `Invalid instance type \`${instanceType}\`.`,
    };
  }
  const nodeCountText = options.get("--nodes")!;
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
  return {
    kind: "request",
    request: { dataset: words[2], instanceType, nodeCount },
  };
}
