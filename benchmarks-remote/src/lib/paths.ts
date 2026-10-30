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

const DATASET_SEGMENT = /^[a-zA-Z0-9._=-]+$/;
const DATASET_EXAMPLE =
  "tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false";

/**
 * Short dataset names used before datasets moved to the parameter-encoded path layout,
 * mapped to their current equivalent (the default `dfbench prepare-*` layout). Resolve
 * aliases before benchmarking; do not apply them to destructive operations such as
 * dataset deletion, which must act on the literal path the caller named.
 */
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

/** Resolves a dataset name predating the parameter-encoded layout to its current path. */
export function resolveDatasetAlias(dataset: string): string {
  return DATASET_ALIASES.get(dataset) ?? dataset;
}

/**
 * Splits and validates a dataset path, an S3 prefix encoding every dataset generation
 * parameter (e.g. `tpch_parquet/scale_factor=1/max_file_size=134217728/dictionary=pages/sorted=false`).
 */
export function datasetParts(dataset: string): string[] {
  const parts = dataset.split("/");
  if (
    parts.length < 2 ||
    parts.some(
      (part) => part === "." || part === ".." || !DATASET_SEGMENT.test(part),
    )
  ) {
    throw new Error(
      `Invalid dataset '${dataset}'; expected a path such as ${DATASET_EXAMPLE}`,
    );
  }
  return parts;
}

/**
 * The query suite of a dataset path: its first path component, with a trailing `_<format>`
 * (e.g. `_parquet`, `_iceberg`) dropped. The remaining components are `key=value` generation
 * parameters, so suite queries live at `<testdataRoot>/<suite>/queries` regardless of them.
 */
export function datasetSuite(dataset: string): string {
  const [suitePart] = datasetParts(dataset);
  return suitePart!.split("_")[0]!;
}

export function datasetPath(
  dataset: string,
  testdataRoot = path.join(datafusionDistributedRoot(), "testdata"),
): string {
  return path.join(testdataRoot, ...datasetParts(dataset));
}
