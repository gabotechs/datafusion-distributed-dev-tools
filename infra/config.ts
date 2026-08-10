import * as pulumi from "@pulumi/pulumi";

export interface ControllerConfig {
  namePrefix: string;
  region: string;
  controllerSubnetId: string | undefined;
  controllerInstanceType: string;
  controllerVolumeSizeGiB: number;
  clusterName: string;
  datasetBucketName: string;
  benchmarkInstanceType: string;
  benchmarkNodeCount: number;
  benchmarkWorkloadRoleArn: string;
  githubRepository: string;
  sourceRepositoryUrl: string;
  nodeVersion: string;
  nodeSha256: string;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function validateControllerConfig(
  config: ControllerConfig,
): ControllerConfig {
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(config.namePrefix)) {
    throw new Error(
      "namePrefix must start with a lowercase letter, contain only lowercase letters, numbers, and hyphens, and be at most 20 characters",
    );
  }
  positiveInteger("controllerVolumeSizeGiB", config.controllerVolumeSizeGiB);
  positiveInteger("benchmarkNodeCount", config.benchmarkNodeCount);
  if (!/^[0-9a-f]{64}$/.test(config.nodeSha256)) {
    throw new Error("nodeSha256 must be a lowercase SHA-256 digest");
  }
  if (
    !/^arn:[^:]+:iam::[0-9]{12}:role\/.+/.test(config.benchmarkWorkloadRoleArn)
  ) {
    throw new Error("benchmarkWorkloadRoleArn must be an IAM role ARN");
  }
  return config;
}

export function loadControllerConfig(): ControllerConfig {
  const config = new pulumi.Config();
  const aws = new pulumi.Config("aws");
  return validateControllerConfig({
    namePrefix: config.get("namePrefix") ?? "df-pr-bot",
    region: aws.require("region"),
    controllerSubnetId: config.get("controllerSubnetId"),
    controllerInstanceType:
      config.get("controllerInstanceType") ?? "c7i.4xlarge",
    controllerVolumeSizeGiB: config.getNumber("controllerVolumeSizeGiB") ?? 500,
    clusterName: config.require("clusterName"),
    datasetBucketName: config.require("datasetBucketName"),
    benchmarkInstanceType: config.require("benchmarkInstanceType"),
    benchmarkNodeCount: config.requireNumber("benchmarkNodeCount"),
    benchmarkWorkloadRoleArn: config.require("benchmarkWorkloadRoleArn"),
    githubRepository: config.require("githubRepository"),
    sourceRepositoryUrl: config.require("sourceRepositoryUrl"),
    nodeVersion: config.get("nodeVersion") ?? "24.18.1",
    nodeSha256:
      config.get("nodeSha256") ??
      "d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0",
  });
}
