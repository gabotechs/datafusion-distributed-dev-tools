import { BenchmarkRun } from "./results";

export function compareStoredResults(
  dataset: string,
  baseResultName: string,
  newResultName: string,
  testdataRoot?: string,
): string {
  const base = new BenchmarkRun(
    dataset,
    baseResultName,
    undefined,
    testdataRoot,
  );
  base.loadResults();
  const next = new BenchmarkRun(
    dataset,
    newResultName,
    undefined,
    testdataRoot,
  );
  next.loadResults();

  if (base.results.length === 0) {
    throw new Error(
      `No stored results found for '${baseResultName}' and dataset '${dataset}'`,
    );
  }
  if (next.results.length === 0) {
    throw new Error(
      `No stored results found for '${newResultName}' and dataset '${dataset}'`,
    );
  }
  const baseQueries = base.results.map((result) => result.id);
  const newQueries = next.results.map((result) => result.id);
  if (baseQueries.join("\0") !== newQueries.join("\0")) {
    throw new Error(
      `Stored query sets differ: base=[${baseQueries.join(", ")}], new=[${newQueries.join(", ")}]`,
    );
  }

  return next.comparison(base);
}
