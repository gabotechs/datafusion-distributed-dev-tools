import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";

import { datafusionDistributedRoot } from "./paths";

export function datafusionDistributedGitReference(
  sourceRoot = datafusionDistributedRoot(),
): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  };

  try {
    const branch = execFileSync(
      "git",
      ["-C", sourceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"],
      options,
    ).trim();
    const normalizedBranch = branch.split("/").at(-1);
    if (normalizedBranch) return normalizedBranch;
  } catch {
    // Detached worktrees do not have a symbolic branch; use their commit.
  }

  try {
    const commit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "--short=12", "HEAD"],
      options,
    ).trim();
    if (commit) return commit;
  } catch {
    // Report one actionable error below.
  }

  throw new Error(
    `Could not determine the Git reference of DataFusion Distributed at ${sourceRoot}`,
  );
}
