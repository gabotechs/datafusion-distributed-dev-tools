import { execFileSync } from "node:child_process";

import { Command } from "commander";

import { getBucketUri } from "../lib/bucket";
import {
  containsParquetFiles,
  discoverDatasets,
  selectDatasets,
} from "../lib/datasets";
import { errorMessage } from "../lib/filesystem";
import { testdataRoots } from "../lib/paths";

function main(): void {
  const program = new Command()
    .option("--list", "List locally available datasets without syncing")
    .option("-d, --dataset <dataset...>", "Sync only the selected dataset(s)")
    .parse(process.argv);
  const options = program.opts<{ list?: boolean; dataset?: string[] }>();
  const datasets = discoverDatasets(testdataRoots());

  if (options.list) {
    for (const dataset of datasets) {
      console.log(dataset.name);
    }
    return;
  }

  const selected = selectDatasets(datasets, options.dataset ?? []);
  const empty = selected.filter(
    (dataset) => !containsParquetFiles(dataset.source),
  );
  if (empty.length > 0) {
    throw new Error(
      `Dataset(s) contain no Parquet files: ${empty.map((dataset) => dataset.name).join(", ")}`,
    );
  }
  const target = getBucketUri().replace(/\/+$/, "");
  for (const dataset of selected) {
    const destination = `${target}/${dataset.name}`;
    console.log(
      `Syncing local dataset '${dataset.source}' to '${destination}'...`,
    );
    execFileSync(
      "aws",
      [
        "s3",
        "sync",
        dataset.source,
        destination,
        "--delete",
        "--exclude",
        "*",
        "--include",
        "*.parquet",
      ],
      { stdio: "inherit" },
    );
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
