import { readFileSync } from "node:fs";
import path from "node:path";

import type { ControllerConfig } from "./config.js";
import { repositoryRoot } from "./paths.js";
import { controllerToolVersions } from "./versions.js";

export const controllerSetupFiles = [
  "00-header.sh",
  "01-system-packages.sh",
  "02-node.sh",
  "03-kubernetes-clients.sh",
  "04-identities.sh",
  "05-application.sh",
  "06-build-wrappers.sh",
  "07-rust.sh",
  "08-zig.sh",
  "09-controller-environment.sh",
  "10-foundation-access.sh",
  "11-systemd-service.sh",
  "12-cloudwatch.sh",
  "13-start-service.sh",
] as const;

interface ControllerSetupArguments {
  config: ControllerConfig;
  applicationKey: string;
  artifactBucketName: string;
}

function renderSection(
  file: (typeof controllerSetupFiles)[number],
  replacements: Record<string, string>,
): string {
  const filePath = path.join(
    repositoryRoot(),
    "benchmark-bot",
    "controller",
    "setup",
    file,
  );
  return readFileSync(filePath, "utf8")
    .trimEnd()
    .replace(/\{\{([A-Z0-9_]+)\}\}/g, (_placeholder, name: string) => {
      const replacement = replacements[name];
      if (replacement === undefined) {
        throw new Error(`No controller setup value was provided for ${name}`);
      }
      return replacement;
    });
}

export function renderControllerSetup(args: ControllerSetupArguments): string {
  const { config } = args;
  const replacements: Record<string, string> = {
    APPLICATION_KEY: args.applicationKey,
    ARTIFACT_BUCKET_NAME: args.artifactBucketName,
    AUTHORIZED_GITHUB_LOGINS: config.authorizedGithubLogins.join(","),
    AWS_REGION: config.region,
    CARGO_ZIGBUILD_VERSION: controllerToolVersions.cargoZigbuild,
    DATASET_BUCKET_NAME: config.datasetBucketName,
    EKS_CLUSTER_NAME: config.clusterName,
    GITHUB_REPOSITORY: config.githubRepository,
    HELM_SHA256: controllerToolVersions.helm.sha256,
    HELM_VERSION: controllerToolVersions.helm.version,
    KUBECTL_SHA256: controllerToolVersions.kubectl.sha256,
    KUBECTL_VERSION: controllerToolVersions.kubectl.version,
    NODE_SHA256: config.nodeSha256,
    NODE_VERSION: config.nodeVersion,
    RUST_TOOLCHAIN: controllerToolVersions.rust,
    RUSTUP_SHA256: controllerToolVersions.rustup.sha256,
    RUSTUP_VERSION: controllerToolVersions.rustup.version,
    SOURCE_REPOSITORY_URL: config.sourceRepositoryUrl,
    ZIG_SHA256: controllerToolVersions.zig.sha256,
    ZIG_VERSION: controllerToolVersions.zig.version,
  };

  return `${controllerSetupFiles
    .map((file) => renderSection(file, replacements))
    .join("\n\n")}\n`;
}
