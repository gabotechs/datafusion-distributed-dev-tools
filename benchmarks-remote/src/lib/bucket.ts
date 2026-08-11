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

function getBucketFromLocalOutputs(): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(PULUMI_OUTPUT_FILE, "utf8");
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return undefined;
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
  const value = (outputs as Record<string, unknown>).datasetBucketName;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Pulumi outputs at ${PULUMI_OUTPUT_FILE} do not contain a valid datasetBucketName`,
    );
  }
  return normalizeBucketUri(value);
}

export function getBucketUri(): string {
  const fromEnvironment = process.env.BENCHMARK_BUCKET;
  if (fromEnvironment) {
    return normalizeBucketUri(fromEnvironment);
  }

  const fromLocalOutputs = getBucketFromLocalOutputs();
  if (fromLocalOutputs) {
    return fromLocalOutputs;
  }

  throw new Error(
    "Could not resolve benchmark bucket. Set BENCHMARK_BUCKET or run npm run foundation-deploy from benchmarks-remote.",
  );
}
