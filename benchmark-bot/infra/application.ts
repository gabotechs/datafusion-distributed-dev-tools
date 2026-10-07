import path from "node:path";

import * as pulumi from "@pulumi/pulumi";

import { repositoryRoot } from "./paths.js";

const botRoot = path.join(repositoryRoot(), "benchmark-bot");
const benchmarkRoot = path.join(repositoryRoot(), "benchmarks-remote");

export function applicationArchive(): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    src: new pulumi.asset.FileArchive(
      path.join(botRoot, "dist", "application", "src"),
    ),
    migrations: new pulumi.asset.FileArchive(path.join(botRoot, "migrations")),
    controller: new pulumi.asset.FileArchive(path.join(botRoot, "controller")),
    "benchmarks-remote": new pulumi.asset.AssetArchive({
      "package.json": new pulumi.asset.FileAsset(
        path.join(benchmarkRoot, "package.json"),
      ),
      dist: new pulumi.asset.AssetArchive({
        "datafusion-bench.cjs": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "dist", "datafusion-bench.cjs"),
        ),
        "compare.cjs": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "dist", "compare.cjs"),
        ),
        "deploy-engine.cjs": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "dist", "deploy-engine.cjs"),
        ),
        "destroy-engine.cjs": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "dist", "destroy-engine.cjs"),
        ),
      }),
      k8s: new pulumi.asset.AssetArchive({
        datafusion: new pulumi.asset.FileArchive(
          path.join(benchmarkRoot, "k8s", "datafusion"),
        ),
        "worker-resources.yaml": new pulumi.asset.FileAsset(
          path.join(benchmarkRoot, "k8s", "worker-resources.yaml"),
        ),
      }),
    }),
  });
}
