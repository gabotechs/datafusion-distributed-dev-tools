import fs from "node:fs";
import path from "node:path";

import {
  argument,
  message,
  object,
  option,
  optional,
  string,
} from "@optique/core";
import { runSync } from "@optique/run";

import { compareStoredResults } from "../lib/compare";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  dataset: argument(string({ metavar: "DATASET" }), {
    description: message`Dataset to compare`,
  }),
  output: optional(
    option("--output", string({ metavar: "PATH" }), {
      description: message`Write the comparison to a file`,
    }),
  ),
  testdataRoot: option("--testdata-root", string({ metavar: "PATH" }), {
    description: message`Benchmark testdata directory`,
  }),
  baseResultName: argument(string({ metavar: "BASE_RESULT_NAME" })),
  compareResultName: argument(string({ metavar: "COMPARE_RESULT_NAME" })),
});

async function main(): Promise<void> {
  const options = runSync(Options, { help: "option", showDefault: true });

  const comparison = compareStoredResults(
    options.dataset,
    options.baseResultName,
    options.compareResultName,
    options.testdataRoot,
  );
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, `${comparison}\n`);
  } else {
    console.log(comparison);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
