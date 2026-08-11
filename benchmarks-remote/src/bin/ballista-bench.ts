import { z } from "zod";
import { runSync } from "@optique/run";

import {
  commonOptions,
  runEngineBenchmark,
  type CommonOptions as CommonOptionValues,
} from "../lib/engine-cli";
import type { ExecuteQueryResult, TableSpec } from "../lib/runner";
import { splitViewQuery, type BenchmarkRunner } from "../lib/runner";

const queryResponseSchema = z.object({
  count: z.number(),
  plan: z.string(),
  elapsed_ms: z.number(),
});
type QueryResponse = z.infer<typeof queryResponseSchema>;

export class BallistaRunner implements BenchmarkRunner {
  readonly engine = "ballista";

  constructor(public readonly options: CommonOptionValues) {}

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

    return {
      rowCount: response.count,
      plan: response.plan,
      elapsed: response.elapsed_ms,
      tasks: 0,
    };
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
    for (const table of tables) {
      await this.query(`DROP TABLE IF EXISTS ${table.name}`);
      await this.query(
        `CREATE EXTERNAL TABLE IF NOT EXISTS ${table.name} STORED AS PARQUET LOCATION '${table.s3Path}'`,
      );
    }
  }
}

if (require.main === module) {
  const options = runSync(commonOptions("ballista"), {
    help: "option",
    showDefault: true,
  });
  void runEngineBenchmark(new BallistaRunner(options));
}
