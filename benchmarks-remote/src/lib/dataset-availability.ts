import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

const SUCCESS_SUFFIX = "/_SUCCESS";

/**
 * Lists dataset paths with a completed `_SUCCESS` marker under the given bucket prefix,
 * relative to that prefix. Paginates across the whole bucket regardless of object count.
 */
export async function listAvailableDatasets(
  client: S3Client,
  bucketName: string,
  prefix = "",
): Promise<string[]> {
  const datasets: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
      }),
    );
    for (const { Key } of response.Contents ?? []) {
      if (Key?.endsWith(SUCCESS_SUFFIX)) {
        datasets.push(Key.slice(prefix.length, -SUCCESS_SUFFIX.length));
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return datasets.sort();
}
