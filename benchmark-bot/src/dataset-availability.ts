import { loadOutputs } from "./executor.js";
import type { ProcessRunner } from "./process.js";

export interface DatasetAvailabilityConfig {
  foundationOutputsFile: string;
  region: string;
}

const SUCCESS_SUFFIX = "/_SUCCESS";

/**
 * Lists dataset paths the foundation's dataset bucket has fully generated, by their
 * `_SUCCESS` completion marker. `list-objects-v2` auto-paginates across the whole bucket
 * by default, so this sees every marker regardless of how many objects exist.
 */
export async function listAvailableDatasets(
  processes: ProcessRunner,
  config: DatasetAvailabilityConfig,
): Promise<string[]> {
  const { datasetBucketName } = loadOutputs(config.foundationOutputsFile);
  const result = await processes.run(
    "aws",
    [
      "--region",
      config.region,
      "s3api",
      "list-objects-v2",
      "--bucket",
      datasetBucketName,
      "--query",
      "Contents[?ends_with(Key, '_SUCCESS')].Key",
      "--output",
      "json",
    ],
    { quiet: true },
  );
  const keys = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(keys)) {
    throw new Error(`Invalid dataset listing for bucket ${datasetBucketName}`);
  }
  return keys
    .filter(
      (key): key is string =>
        typeof key === "string" && key.endsWith(SUCCESS_SUFFIX),
    )
    .map((key) => key.slice(0, -SUCCESS_SUFFIX.length))
    .sort();
}
