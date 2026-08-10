import path from "node:path";
import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function applicationArchive(): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    "package.json": new pulumi.asset.FileAsset(
      path.join(repositoryRoot, "package.json"),
    ),
    "package-lock.json": new pulumi.asset.FileAsset(
      path.join(repositoryRoot, "package-lock.json"),
    ),
    "tsconfig.json": new pulumi.asset.FileAsset(
      path.join(repositoryRoot, "tsconfig.json"),
    ),
    src: new pulumi.asset.FileArchive(path.join(repositoryRoot, "src")),
    migrations: new pulumi.asset.FileArchive(
      path.join(repositoryRoot, "migrations"),
    ),
    builder: new pulumi.asset.FileArchive(path.join(repositoryRoot, "builder")),
  });
}
