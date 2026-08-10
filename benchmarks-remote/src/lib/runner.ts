export interface TableSpec {
  suite: string;
  schema: string;
  name: string;
  s3Path: string;
}

export interface ExecuteQueryResult {
  rowCount: number;
  plan: string;
  elapsed: number;
  tasks: number;
  statsQErrorP50?: number;
  statsQErrorP95?: number;
}

export interface BenchmarkRunner {
  createTables(s3Paths: TableSpec[]): Promise<void>;

  executeQuery(query: string): Promise<ExecuteQueryResult>;
}

export function splitViewQuery(
  sql: string,
): [string, string, string] | undefined {
  if (!/create\s+view/i.test(sql)) {
    return undefined;
  }
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const [createView, query, dropView] = statements;
  if (!createView || !query || !dropView || statements.length !== 3) {
    throw new Error(
      "Expected CREATE VIEW benchmark query to contain three statements",
    );
  }
  return [createView, query, dropView];
}
