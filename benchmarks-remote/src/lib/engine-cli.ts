import { Command, InvalidArgumentError } from "commander";

import { errorMessage } from "./filesystem";
import { runBenchmark } from "./run-benchmark";
import type { BenchmarkRun } from "./results";
import type { BenchmarkRunner } from "./runner";

interface CommonCommandOptions {
  dataset: string;
  iterations: number;
  timeSecs: number;
  queries?: string;
  debug: boolean;
  warmup: boolean;
  compare: boolean;
}

export interface EngineBenchmarkConfiguration<
  ExtraOptions extends object = object,
> {
  engine: string | ((options: CommonCommandOptions & ExtraOptions) => string);
  createRunner: (
    options: CommonCommandOptions & ExtraOptions,
  ) => BenchmarkRunner;
  addOptions?: (command: Command) => void;
}

export function integerArgument(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`Expected an integer, got '${value}'`);
  }
  return parsed;
}

export function numberArgument(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError(`Expected a number, got '${value}'`);
  }
  return parsed;
}

export function booleanArgument(value: string): boolean {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new InvalidArgumentError(`Expected true or false, got '${value}'`);
}

function queryArguments(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const queries = value
    .split(",")
    .map((query) => query.trim())
    .filter(Boolean);
  if (queries.length === 0) {
    throw new Error("--queries must contain at least one query ID");
  }
  return queries;
}

export async function executeEngineBenchmark<ExtraOptions extends object>(
  configuration: EngineBenchmarkConfiguration<ExtraOptions>,
  argv: readonly string[] = process.argv,
): Promise<BenchmarkRun> {
  const program = new Command()
    .requiredOption("--dataset <string>", "Dataset to run queries on")
    .option(
      "-i, --iterations <number>",
      "Number of iterations",
      integerArgument,
      5,
    )
    .option(
      "--time-secs <number>",
      "Minimum measured time per query in seconds",
      numberArgument,
      0,
    )
    .option("--queries <string>", "Comma-separated query IDs to run")
    .option(
      "--debug <boolean>",
      "Print generated plans to stderr",
      booleanArgument,
      false,
    )
    .option(
      "--warmup <boolean>",
      "Perform a warmup query before the benchmarks",
      booleanArgument,
      true,
    )
    .option("--no-compare", "Do not compare this run with the previous run");
  configuration.addOptions?.(program);
  program.parse([...argv]);

  const options = program.opts<CommonCommandOptions & ExtraOptions>();
  const queries = queryArguments(options.queries);
  const benchmarkRun = await runBenchmark(configuration.createRunner(options), {
    dataset: options.dataset,
    engine:
      typeof configuration.engine === "string"
        ? configuration.engine
        : configuration.engine(options),
    iterations: options.iterations,
    timeSecs: options.timeSecs,
    queries,
    debug: options.debug,
    warmup: options.warmup,
  });

  const previous = options.compare ? benchmarkRun.loadPrevious() : null;
  if (previous) {
    console.log(benchmarkRun.comparison(previous));
  }
  benchmarkRun.store();
  return benchmarkRun;
}

export function runEngineBenchmark<ExtraOptions extends object>(
  configuration: EngineBenchmarkConfiguration<ExtraOptions>,
): void {
  void executeEngineBenchmark(configuration).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
