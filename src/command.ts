export interface BenchmarkRequest {
  dataset: string;
}

export type ParseResult =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "request"; request: BenchmarkRequest };

const DATASET = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

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
  if (words.length !== 3 || !words[2]) {
    return {
      kind: "invalid",
      message: "Expected `benchmarks run <suite>/<variant>`.",
    };
  }
  if (!DATASET.test(words[2])) {
    return {
      kind: "invalid",
      message: `Invalid dataset \`${words[2]}\`; expected a path such as \`tpch/sf1\`.`,
    };
  }
  return { kind: "request", request: { dataset: words[2] } };
}
