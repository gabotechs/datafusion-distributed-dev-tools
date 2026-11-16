import fs from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  merge,
  message,
  object,
  option,
  optional,
  string,
  withDefault,
  type InferValue,
} from "@optique/core";
import { runSync } from "@optique/run";

import { CommonOptions, runEngineBenchmark } from "../lib/engine-cli";
import { errorMessage } from "../lib/filesystem";
import { datafusionDistributedGitReference } from "../lib/git-reference";
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";

/** The default `--config-path`, relative to the current directory. */
const DEFAULT_CONFIG_PATH = ".df-bench.yaml";

type ConfigEntry = [name: string, value: string];

const Options = object({
  resultName: withDefault(
    option("--result-name", string({ metavar: "NAME" }), {
      description: message`Name used to store benchmark results`,
    }),
    () => `datafusion-distributed-${datafusionDistributedGitReference()}`,
  ),
  configPath: optional(
    option("--config-path", string({ metavar: "FILE" }), {
      description: message`YAML file with flat DataFusion and distributed config options as key: value pairs. Defaults to ${DEFAULT_CONFIG_PATH} in the current directory, which is skipped if it doesn't exist`,
    }),
  ),
  configs: option("-c", "--config", string({ metavar: "KEY=VALUE" }), {
    description: message`A DataFusion or distributed config option, such as distributed.dynamic_task_count=true. Can be repeated, and takes precedence over the config file`,
  }).multiple(),
});

const DataFusionOptions = merge(CommonOptions, Options);

type DataFusionOptions = InferValue<typeof DataFusionOptions>;

const queryResponseSchema = z.object({
  count: z.number(),
  plan: z.string(),
  plan_dump: z.string().optional(),
  elapsed_ms: z.number(),
  tasks: z.number(),
  stats_q_error_p50: z.number().nullable(),
  stats_q_error_p95: z.number().nullable(),
});
type QueryResponse = z.infer<typeof queryResponseSchema>;

export function dataFusionServiceName(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return `datafusion-${(environment.USER || userInfo().username).replaceAll(".", "-")}`;
}

export class DataFusionRunner implements BenchmarkRunner {
  readonly defaultService = dataFusionServiceName();
  readonly supportedFileTypes = ["PARQUET", "ICEBERG"] as const;
  readonly deployment = "datafusion";
  readonly resultName: string;

  constructor(public readonly options: DataFusionOptions) {
    this.resultName = options.resultName;
  }

  async executeQuery(sql: string): Promise<ExecuteQueryResult> {
    const viewQuery = splitViewQuery(sql);
    let response: QueryResponse;
    if (viewQuery) {
      const [createView, query, dropView] = viewQuery;
      await this.query(createView);
      response = await this.query(query);
      await this.query(dropView);
    } else {
      response = await this.query(sql);
    }

    const result: ExecuteQueryResult = {
      rowCount: response.count,
      plan: response.plan,
      elapsed: response.elapsed_ms,
      tasks: response.tasks,
    };
    if (response.plan_dump !== undefined) {
      result.planDump = response.plan_dump;
    }
    if (response.stats_q_error_p50 !== null) {
      result.statsQErrorP50 = response.stats_q_error_p50;
    }
    if (response.stats_q_error_p95 !== null) {
      result.statsQErrorP95 = response.stats_q_error_p95;
    }
    return result;
  }

  private async query(sql: string): Promise<QueryResponse> {
    const url = new URL(this.options.url);
    url.searchParams.set("sql", sql);
    const response = await fetch(url);

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Query failed: ${response.status} ${message}`);
    }
    return queryResponseSchema.parse(await response.json());
  }

  async createTables(tables: TableSpec[]): Promise<void> {
    let statement = "";
    for (const table of tables) {
      statement += `
    DROP TABLE IF EXISTS ${table.name};
    CREATE EXTERNAL TABLE IF NOT EXISTS ${table.name} STORED AS ${table.fileType} LOCATION '${table.s3Path.replaceAll("'", "''")}';
 `;
    }
    await this.query(statement);
    const entries = configEntries(this.options);
    console.error(`Config: ${JSON.stringify(entries)}`);
    await this.query(dataFusionSettingStatements(entries));
  }
}

/** Applied before any user config, so a config file or `-c` can override it. */
const DEFAULT_CONFIG_ENTRIES: readonly ConfigEntry[] = [
  // Task counts and statistics estimation errors are read from the metrics.
  ["distributed.collect_metrics", "true"],
];

/** Parses a `-c key=value` entry. */
export function parseConfigEntry(entry: string): ConfigEntry {
  const separator = entry.indexOf("=");
  if (separator === -1) {
    throw new Error(`Invalid config '${entry}'; expected KEY=VALUE`);
  }
  return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
}

/** Reads the flat `key: value` config entries of a YAML file, in file order. */
export function readConfigFile(file: string): ConfigEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${errorMessage(error)}`);
  }
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new Error(`Invalid YAML in ${file}: ${errorMessage(error)}`);
  }
  // A file with only comments is a null document.
  if (document === null || document === undefined) return [];
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${file} must contain flat key: value pairs`);
  }
  return Object.entries(document).map(([key, value]) => {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Config value of ${key} in ${file} must be a scalar`);
    }
    return [key, String(value)];
  });
}

/**
 * The config file entries followed by the `-c` ones, so that applying them in
 * order makes the `-c` ones take precedence. Paths resolve against the
 * directory npm was invoked from.
 */
export function configEntries(
  options: { configPath?: string | undefined; configs: readonly string[] },
  cwd: string = process.env.INIT_CWD ?? process.cwd(),
): ConfigEntry[] {
  const defaultPath = path.resolve(cwd, DEFAULT_CONFIG_PATH);
  const entries =
    options.configPath !== undefined
      ? readConfigFile(path.resolve(cwd, options.configPath))
      : fs.existsSync(defaultPath)
        ? readConfigFile(defaultPath)
        : [];
  return [...entries, ...options.configs.map(parseConfigEntry)];
}

/** SET statements applying the default config entries and then `entries`. */
export function dataFusionSettingStatements(
  entries: readonly ConfigEntry[],
): string {
  return [...DEFAULT_CONFIG_ENTRIES, ...entries]
    .map(([name, value]) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(name)) {
        throw new Error(`Invalid config key '${name}'`);
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
        throw new Error(
          `Invalid config value '${value}' for ${name}; expected a safe token`,
        );
      }
      return `SET ${name}=${value};`;
    })
    .join("\n");
}

if (require.main === module) {
  const options = runSync(DataFusionOptions, {
    help: "option",
    showDefault: true,
  });
  void runEngineBenchmark(new DataFusionRunner(options));
}
