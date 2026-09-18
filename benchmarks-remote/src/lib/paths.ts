import path from "node:path";

function findDevToolsRoot(): string {
  for (const start of [__dirname, process.cwd()]) {
    let candidate = path.resolve(start);
    while (true) {
      if (path.basename(candidate) === "benchmarks-remote") {
        return path.dirname(candidate);
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        break;
      }
      candidate = parent;
    }
  }

  throw new Error(
    `Could not find the development-tools repository from ${__dirname} or ${process.cwd()}`,
  );
}

/** Root of the development-tools checkout, for source and bundled entry points. */
export const DEV_TOOLS_ROOT = findDevToolsRoot();

/**
 * The source checkout intentionally lives beside this repository:
 *
 *   <parent>/datafusion-distributed-dev-tools
 *   <parent>/datafusion-distributed
 */
export const DEFAULT_DATAFUSION_DISTRIBUTED_ROOT = path.resolve(
  DEV_TOOLS_ROOT,
  "../datafusion-distributed",
);

export function datafusionDistributedRoot(): string {
  const configured = process.env.DATAFUSION_DISTRIBUTED_ROOT;
  return configured
    ? path.resolve(DEV_TOOLS_ROOT, configured)
    : DEFAULT_DATAFUSION_DISTRIBUTED_ROOT;
}

export function datasetParts(dataset: string): [string, string] {
  const match = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/.exec(dataset);
  if (
    !match?.[1] ||
    !match[2] ||
    [match[1], match[2]].some((part) => part === "." || part === "..")
  ) {
    throw new Error(
      `Invalid dataset '${dataset}'; expected a path such as tpch/sf10`,
    );
  }
  return [match[1], match[2]];
}

export function datasetPath(
  dataset: string,
  testdataRoot = path.join(datafusionDistributedRoot(), "testdata"),
): string {
  return path.join(testdataRoot, ...datasetParts(dataset));
}
