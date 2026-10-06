import { z } from "zod";
import { runSync } from "@optique/run";

import {
  CommonOptions,
  runEngineBenchmark,
  type CommonOptions as CommonOptionValues,
} from "../lib/engine-cli";
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";
import { replaceTableReferences } from "../lib/table-references";

// Matches the remote_servers entry in k8s/clickhouse/templates/config.yaml.
const CLUSTER = "benchmark";

export const clickhouseQueryResponseSchema = z
  .object({
    rows: z.number(),
    statistics: z
      .object({
        elapsed: z.number(),
      })
      .loose(),
  })
  .loose();

const describeResponseSchema = z.object({
  data: z.array(z.tuple([z.string(), z.string()]).rest(z.unknown())),
});

// ClickBench Parquet files store EventDate as days since the Unix epoch.
const COLUMN_TYPES: Record<string, Record<string, Record<string, string>>> = {
  clickbench: { hits: { EventDate: "Date" } },
};

export function clickhouseTableUrl(table: TableSpec, region: string): string {
  const match = /^s3:\/\/([^/]+)\/(.+?)\/?$/.exec(table.s3Path);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid S3 table path '${table.s3Path}'`);
  }
  return `https://${match[1]}.s3.${region}.amazonaws.com/${match[2]}/*.parquet`;
}

export function clickhouseTableSource(
  table: TableSpec,
  url: string,
  columns: readonly (readonly [string, string])[],
): string {
  const types = COLUMN_TYPES[table.suite]?.[table.name] ?? {};
  const structure = columns
    .map(([name, type]) => `\`${name}\` ${types[name] ?? type}`)
    .join(", ")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
  return `s3Cluster('${CLUSTER}', '${url}', 'Parquet', '${structure}')`;
}

export function clickhouseDialect(sql: string): string {
  sql = sql.replace(
    /create view revenue0 \(supplier_no, total_revenue\) as\s+select\s+l_suppkey,\s+sum\(l_extendedprice \* \(1 - l_discount\)\)/is,
    "create view revenue0 as select l_suppkey as supplier_no, sum(l_extendedprice * (1 - l_discount)) as total_revenue",
  );
  sql = sql.replace(/to_timestamp_seconds\(/gi, "toDateTime(");
  // ClickHouse string literals treat a backslash as an escape character.
  sql = sql.replace(/'\\(\d)'/g, "'\\\\$1'");
  return sql;
}

function isCorrelatedSubqueryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "Correlated subqueries are not supported with remote tables",
    )
  );
}

export class ClickHouseRunner implements BenchmarkRunner {
  readonly deployment = "clickhouse";
  readonly resultName = "clickhouse";
  // Reading the cluster table function directly, rather than through a view,
  // lets ClickHouse run filters and partial aggregation on every worker.
  // ClickHouse rejects correlated subqueries over remote tables, so those
  // queries read each table through a view instead.
  private readonly sources = new Map<string, string>();
  private readonly viewSources = new Map<string, string>();
  private readonly correlatedQueries = new Set<string>();

  constructor(public readonly options: CommonOptionValues) {}

  async executeQuery(sql: string): Promise<ExecuteQueryResult> {
    sql = clickhouseDialect(sql);

    let response: string;
    if (this.correlatedQueries.has(sql)) {
      response = await this.execute(sql, this.viewSources);
    } else {
      try {
        response = await this.execute(sql, this.sources);
      } catch (error: unknown) {
        if (!isCorrelatedSubqueryError(error)) throw error;
        this.correlatedQueries.add(sql);
        response = await this.execute(sql, this.viewSources);
      }
    }

    const result = clickhouseQueryResponseSchema.parse(JSON.parse(response));
    return {
      rowCount: result.rows,
      plan: "",
      elapsed: result.statistics.elapsed * 1000,
      tasks: 0,
    };
  }

  private async execute(
    sql: string,
    sources: ReadonlyMap<string, string>,
  ): Promise<string> {
    const viewQuery = splitViewQuery(sql);
    if (!viewQuery) {
      return this.query(replaceTableReferences(sql, sources));
    }
    const [createView, query, dropView] = viewQuery;
    await this.query(replaceTableReferences(createView, sources));
    try {
      return await this.query(replaceTableReferences(query, sources));
    } finally {
      await this.query(dropView);
    }
  }

  private async query(sql: string): Promise<string> {
    const url = new URL(this.options.url);
    url.searchParams.set("default_format", "JSONCompact");
    const response = await fetch(url, {
      method: "POST",
      body: sql.trim().replace(/;+$/, ""),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Query failed: ${response.status} ${body}`);
    }
    return body;
  }

  async createTables(tables: TableSpec[]): Promise<void> {
    const firstTable = tables[0];
    if (!firstTable) {
      throw new Error("No tables were provided");
    }
    const database = firstTable.schema;
    this.sources.clear();
    this.viewSources.clear();
    await this.query(`CREATE DATABASE IF NOT EXISTS "${database}"`);
    for (const table of tables) {
      const url = clickhouseTableUrl(table, this.options.region);
      const description = describeResponseSchema.parse(
        JSON.parse(
          await this.query(
            `DESCRIBE TABLE s3Cluster('${CLUSTER}', '${url}', 'Parquet')`,
          ),
        ),
      );
      const source = clickhouseTableSource(
        table,
        url,
        description.data.map(([name, type]) => [name, type] as const),
      );
      const view = `"${database}"."${table.name}"`;
      await this.query(
        `CREATE OR REPLACE VIEW ${view} AS SELECT * FROM ${source}`,
      );
      this.sources.set(table.name.toLowerCase(), source);
      this.viewSources.set(table.name.toLowerCase(), view);
    }
  }
}

if (require.main === module) {
  const options = runSync(CommonOptions, {
    help: "option",
    showDefault: true,
  });
  void runEngineBenchmark(new ClickHouseRunner(options));
}
