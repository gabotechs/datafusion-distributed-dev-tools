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
  elapsed_ms: z.number(),
});
type QueryResponse = z.infer<typeof queryResponseSchema>;

export class SparkRunner implements BenchmarkRunner {
  readonly engine = "spark";

  constructor(public readonly options: CommonOptionValues) {}

  async executeQuery(sql: string): Promise<ExecuteQueryResult> {
    sql = sql.replace(/(?<!date\s)('[\d]{4}-[\d]{2}-[\d]{2}')/gi, "DATE $1");
    sql = sql.replace(/to_timestamp_seconds\(/gi, "from_unixtime(");

    const viewQuery = splitViewQuery(sql);
    let response: QueryResponse;
    if (viewQuery) {
      let [createView, query, dropView] = viewQuery;
      createView = createView.replace(
        /create\s+(?:or\s+replace\s+)?view\s+/gi,
        "CREATE OR REPLACE TEMPORARY VIEW ",
      );
      await this.query(createView);
      response = await this.query(query);
      await this.query(dropView);
    } else {
      response = await this.query(sql);
    }

    return {
      rowCount: response.count,
      plan: "",
      elapsed: response.elapsed_ms,
      tasks: 0,
    };
  }

  private async query(sql: string): Promise<QueryResponse> {
    const response = await fetch(`${this.options.url}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql.trim().replace(/;+$/, "") }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Query failed: ${response.status} ${message}`);
    }
    return queryResponseSchema.parse(await response.json());
  }

  async createTables(tables: TableSpec[]): Promise<void> {
    for (const table of tables) {
      const s3aPath = table.s3Path.replace("s3://", "s3a://");
      await this.query(`
                CREATE OR REPLACE TEMPORARY VIEW ${table.name}
                USING parquet
                OPTIONS (path '${s3aPath}')
            `);
    }
  }
}

if (require.main === module) {
  const options = runSync(commonOptions("spark"), {
    help: "option",
    showDefault: true,
  });
  void runEngineBenchmark(new SparkRunner(options));
}
