import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedRepositoryRoot: string | undefined;

export function repositoryRoot(): string {
  if (cachedRepositoryRoot) {
    return cachedRepositoryRoot;
  }

  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const isRepositoryRoot = [
      path.join(current, "package.json"),
      path.join(current, "benchmark-bot", "package.json"),
      path.join(current, "benchmarks-remote", "package.json"),
    ].every(existsSync);
    if (isRepositoryRoot) {
      cachedRepositoryRoot = current;
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Could not locate the development tools repository root");
    }
    current = parent;
  }
}
