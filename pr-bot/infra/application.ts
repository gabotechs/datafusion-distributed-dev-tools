import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as pulumi from "@pulumi/pulumi";

function findRepositoryRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      existsSync(path.join(current, "controller", "cargo-build"))
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

export function applicationArchive(): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    src: new pulumi.asset.FileArchive(
      path.join(repositoryRoot, "dist", "application", "src"),
    ),
    migrations: new pulumi.asset.FileArchive(
      path.join(repositoryRoot, "migrations"),
    ),
    controller: new pulumi.asset.FileArchive(
      path.join(repositoryRoot, "controller"),
    ),
  });
}
