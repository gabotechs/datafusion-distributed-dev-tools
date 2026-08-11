import { execFileSync } from "node:child_process";

import { argument, flag, message, object, string } from "@optique/core";
import { runSync } from "@optique/run";

import { getBucketUri } from "../lib/pulumi-output";
import { validateDatasetNames } from "../lib/datasets";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  dataset: argument(string({ metavar: "DATASET" }), {
    description: message`Delete the selected dataset`,
  })
    .multiple()
    .nonEmpty(),
  yes: flag("--yes", {
    description: message`Confirm permanent deletion from S3`,
  }).withDefault(false),
});

function main(): void {
  const options = runSync<typeof Options>(Options, { help: "option" });
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
