import { S3Client } from "@aws-sdk/client-s3";
import { object } from "@optique/core";
import { runSync } from "@optique/run";

import { listAvailableDatasets } from "../lib/dataset-availability";
import { errorMessage } from "../lib/filesystem";
import {
  bucketOption,
  regionOption,
  s3BucketAndPrefix,
} from "../lib/engine-cli";

const Options = object({
  bucket: bucketOption,
  region: regionOption,
});

async function main(): Promise<void> {
  const options = runSync(Options, { help: "option", showDefault: true });
  const { bucketName, prefix } = s3BucketAndPrefix(options.bucket);
  const client = new S3Client({ region: options.region });
  let datasets: string[];
  try {
    datasets = await listAvailableDatasets(client, bucketName, prefix);
  } finally {
    client.destroy();
  }
  if (datasets.length === 0) {
    console.log("No datasets have finished generating in this bucket.");
    return;
  }
  for (const dataset of datasets) {
    console.log(dataset);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
