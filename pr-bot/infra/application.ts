import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";

function findRepositoryRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (
      existsSync(path.join(current, "pr-bot", "controller", "cargo-build")) &&
      existsSync(path.join(current, "benchmarks-remote", "package.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the controller repository root");
    }
    current = parent;
  }
}

const repositoryRoot = findRepositoryRoot();
const botRoot = path.join(repositoryRoot, "pr-bot");
const benchmarkRoot = path.join(repositoryRoot, "benchmarks-remote");

export function applicationArchive(): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    src: new pulumi.asset.FileArchive(
      path.join(botRoot, "dist", "application", "src"),
    ),
    migrations: new pulumi.asset.FileArchive(path.join(botRoot, "migrations")),
    controller: new pulumi.asset.FileArchive(path.join(botRoot, "controller")),
    "benchmarks-remote": new pulumi.asset.AssetArchive({
      dist: new pulumi.asset.AssetArchive({
        "datafusion-bench.cjs": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "dist", "datafusion-bench.cjs"),
        ),
      }),
      engines: new pulumi.asset.AssetArchive({
        datafusion: new pulumi.asset.AssetArchive({
          "Cargo.toml": new pulumi.asset.FileAsset(
            path.join(benchmarkRoot, "engines", "datafusion", "Cargo.toml"),
          ),
          "build.rs": new pulumi.asset.FileAsset(
            path.join(benchmarkRoot, "engines", "datafusion", "build.rs"),
          ),
          src: new pulumi.asset.FileArchive(
            path.join(benchmarkRoot, "engines", "datafusion", "src"),
          ),
        }),
      }),
      k8s: new pulumi.asset.AssetArchive({
        datafusion: new pulumi.asset.FileArchive(
          path.join(benchmarkRoot, "k8s", "datafusion"),
        ),
        "lib.sh": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "k8s", "lib.sh"),
        ),
        "run-benchmark.sh": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "k8s", "run-benchmark.sh"),
        ),
        "worker-resources.yaml": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "k8s", "worker-resources.yaml"),
        ),
      }),
    }),
  });
}
