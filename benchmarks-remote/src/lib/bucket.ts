import fs from "node:fs";
import path from "node:path";

import { errorMessage, isNotFoundError } from "./filesystem";
import { DEV_TOOLS_ROOT } from "./paths";

const PULUMI_OUTPUT_FILE = path.join(
  DEV_TOOLS_ROOT,
  "benchmarks-remote",
  "pulumi",
  ".pulumi-outputs.json",
);

function normalizeBucketUri(bucket: string): string {
  const withoutProtocol = bucket.replace(/^s3:\/\//, "").replace(/\/+$/, "");
  return `s3://${withoutProtocol}`;
}

export interface LocalFoundation {
  bucket: string;
  clusterName: string;
  region: string;
}

export function getLocalFoundation(): LocalFoundation {
  let raw: string;
  try {
    raw = fs.readFileSync(PULUMI_OUTPUT_FILE, "utf8");
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      throw new Error(
        `Missing ${PULUMI_OUTPUT_FILE}; run npm run foundation-deploy first`,
      );
    }
    throw new Error(
      `Could not read Pulumi outputs at ${PULUMI_OUTPUT_FILE}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  let outputs: unknown;
  try {
    outputs = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `Pulumi outputs at ${PULUMI_OUTPUT_FILE} are not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (typeof outputs !== "object" || outputs === null) {
    throw new Error(
      `Pulumi outputs at ${PULUMI_OUTPUT_FILE} must be a JSON object`,
    );
  }
  const values = outputs as Record<string, unknown>;
  const bucket = values.datasetBucketName;
  const clusterName = values.clusterName;
  const region = values.region;
  if (
    typeof bucket !== "string" ||
    bucket.trim() === "" ||
    typeof clusterName !== "string" ||
    clusterName.trim() === "" ||
    typeof region !== "string" ||
    region.trim() === ""
  ) {
    throw new Error(
      `Pulumi outputs at ${PULUMI_OUTPUT_FILE} do not contain valid datasetBucketName, clusterName, and region values`,
    );
  }
  return {
    bucket: normalizeBucketUri(bucket),
    clusterName,
    region,
  };
}

export function getBucketUri(): string {
  const fromEnvironment = process.env.BENCHMARK_BUCKET;
  if (fromEnvironment) {
    return normalizeBucketUri(fromEnvironment);
  }

  return getLocalFoundation().bucket;
}
