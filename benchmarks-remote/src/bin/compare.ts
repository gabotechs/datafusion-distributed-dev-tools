import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { compareStoredResults } from "../lib/compare";
import { errorMessage } from "../lib/filesystem";

async function main(): Promise<void> {
  const program = new Command()
    .requiredOption("--dataset <string>", "Dataset to run queries on")
    .option(
      "--output <path>",
      "Write the comparison to a file instead of stdout",
    )
    .argument("<base_engine>", "the base engine")
    .argument("<compare_engine>", "the engine to compare to")
    .parse(process.argv);

  const options = program.opts<{ dataset: string; output?: string }>();
  const [baseEngine, compareEngine] = program.args;
  if (!baseEngine || !compareEngine || program.args.length !== 2) {
    throw new Error(`Expected exactly 2 arguments, got ${program.args.length}`);
  }

  const comparison = compareStoredResults(
    options.dataset,
    baseEngine,
    compareEngine,
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
