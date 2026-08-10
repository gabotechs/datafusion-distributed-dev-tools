import { execFileSync } from "node:child_process";

import { Command } from "commander";

import { getBucketUri } from "../lib/bucket";
import { validateDatasetNames } from "../lib/datasets";
import { errorMessage } from "../lib/filesystem";

function main(): void {
  const program = new Command()
    .requiredOption(
      "-d, --dataset <dataset...>",
      "Delete the selected dataset(s)",
    )
    .option("--yes", "Confirm permanent deletion from S3")
    .parse(process.argv);
  const options = program.opts<{ dataset: string[]; yes?: boolean }>();
  if (!options.yes) {
    throw new Error("Pass --yes to confirm permanent dataset deletion");
  }

  const datasets = validateDatasetNames(options.dataset);
  const bucket = getBucketUri().replace(/\/+$/, "");
  for (const dataset of datasets) {
    const target = `${bucket}/${dataset}`;
    console.log(`Deleting '${target}'...`);
    execFileSync("aws", ["s3", "rm", target, "--recursive"], {
      stdio: "inherit",
    });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error: unknown) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
