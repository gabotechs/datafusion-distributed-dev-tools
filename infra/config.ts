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
  githubRepository: string;
  sourceRepositoryUrl: string;
  githubAppId: string;
  githubInstallationId: string;
  githubPrivateKey: pulumi.Output<string>;
  nodeVersion: string;
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
    githubRepository: config.require("githubRepository"),
    sourceRepositoryUrl: config.require("sourceRepositoryUrl"),
    githubAppId: config.require("githubAppId"),
    githubInstallationId: config.require("githubInstallationId"),
    githubPrivateKey: config.requireSecret("githubPrivateKey"),
    nodeVersion: config.get("nodeVersion") ?? "24.18.1",
  });
}
