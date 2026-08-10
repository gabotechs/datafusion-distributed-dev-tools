import { z } from "zod";

import { runEngineBenchmark } from "../lib/engine-cli";
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";
import { trinoSchemaForTable } from "../lib/trino-schemas";

export const trinoStatementResponseSchema = z
  .object({
    nextUri: z.string().optional(),
    data: z.array(z.array(z.unknown())).optional(),
    stats: z
      .object({
        elapsedTimeMillis: z.number(),
      })
      .passthrough()
      .optional(),
    error: z
      .object({
        message: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export class TrinoRunner implements BenchmarkRunner {
  private readonly trinoUrl = process.env.TRINO_URL ?? "http://localhost:9000";
  private schema?: string;

  async executeQuery(sql: string): Promise<ExecuteQueryResult> {
    sql = sql.replace(/(?<!date\s)('[\d]{4}-[\d]{2}-[\d]{2}')/gi, "DATE $1");
    sql = sql.replace(
      /create view revenue0 \(supplier_no, total_revenue\) as\s+select\s+l_suppkey,\s+sum\(l_extendedprice \* \(1 - l_discount\)\)/is,
      "create view revenue0 as select l_suppkey as supplier_no, sum(l_extendedprice * (1 - l_discount)) as total_revenue",
    );
    sql = sql.replace(/to_timestamp_seconds\(/gi, "from_unixtime(");

    const viewQuery = splitViewQuery(sql);
    if (viewQuery) {
      const [createView, query, dropView] = viewQuery;
      await this.executeSingleStatement(createView);
      const response = await this.executeSingleStatement(
        `EXPLAIN ANALYZE ${query}`,
      );
      await this.executeSingleStatement(dropView);
      return response;
    }
    return this.executeSingleStatement(`EXPLAIN ANALYZE ${sql}`);
  }

  private async executeSingleStatement(
    sql: string,
  ): Promise<ExecuteQueryResult> {
    if (!this.schema) {
      throw new Error(
        "No schema available; create tables before running queries",
      );
    }

    const submitResponse = await fetch(`${this.trinoUrl}/v1/statement`, {
      method: "POST",
      headers: {
        "X-Trino-User": "benchmark",
        "X-Trino-Catalog": "hive",
        "X-Trino-Schema": this.schema,
      },
      body: sql.trim().replace(/;+$/, ""),
    });
    if (!submitResponse.ok) {
      const message = await submitResponse.text();
      throw new Error(
        `Query submission failed: ${submitResponse.status} ${message}`,
      );
    }

    let result = trinoStatementResponseSchema.parse(
      await submitResponse.json(),
    );
    let rowCount = 0;
    let plan = "";
    let elapsed = 0;

    while (true) {
      if (result.error) {
        throw new Error(`Query failed: ${result.error.message}`);
      }
      if (result.data) {
        const firstCell = result.data[0]?.[0];
        if (typeof firstCell === "string") {
          plan = firstCell;
          const outputRows = /Output.*?(\d+)\s+rows/is.exec(plan)?.[1];
          if (outputRows) {
            rowCount = Number.parseInt(outputRows, 10);
          }
        } else {
          rowCount += result.data.length;
        }
      }
      if (result.stats) {
        elapsed = result.stats.elapsedTimeMillis;
      }
      if (!result.nextUri) {
        break;
      }

      const pollResponse = await fetch(result.nextUri);
      if (!pollResponse.ok) {
        const message = await pollResponse.text();
        throw new Error(
          `Query polling failed: ${pollResponse.status} ${message}`,
        );
      }
      result = trinoStatementResponseSchema.parse(await pollResponse.json());
    }

    return { rowCount, plan, elapsed, tasks: 0 };
  }

  async createTables(tables: TableSpec[]): Promise<void> {
    const firstTable = tables[0];
    if (!firstTable) {
      throw new Error("No tables were provided");
    }
    const schema = firstTable.schema;
    const basePath = firstTable.s3Path.split("/").slice(0, -1).join("/");
    this.schema = schema;

    await this.executeSingleStatement(`
            CREATE SCHEMA IF NOT EXISTS hive."${schema}" WITH (location = '${basePath}')`);

    for (const table of tables) {
      await this.executeSingleStatement(`
                DROP TABLE IF EXISTS hive."${table.schema}"."${table.name}"`);
      await this.executeSingleStatement(`
                CREATE TABLE hive."${table.schema}"."${table.name}" ${trinoSchemaForTable(table)}
                WITH (external_location = '${table.s3Path}', format = 'PARQUET')`);
    }
  }
}

if (require.main === module) {
  runEngineBenchmark({
    engine: "trino",
    createRunner: () => new TrinoRunner(),
  });
}
