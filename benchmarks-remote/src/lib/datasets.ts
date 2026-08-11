import fs from "node:fs";
import path from "node:path";

import { errorMessage, isNotFoundError } from "./filesystem";
import { datasetParts } from "./paths";

export interface Dataset {
  name: string;
  source: string;
}

function isDirectory(directory: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(directory).isDirectory();
  } catch (error: unknown) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw new Error(
      `Could not inspect dataset symlink ${directory}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function containsParquetFiles(directory: string): boolean {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".parquet")) {
      return true;
    }
    if (isDirectory(entryPath, entry) && containsParquetFiles(entryPath)) {
      return true;
    }
  }
  return false;
}

export function discoverDatasets(testdataPaths: string | string[]): Dataset[] {
  const datasets: Dataset[] = [];
  const discovered = new Set<string>();
  for (const testdataPath of typeof testdataPaths === "string"
    ? [testdataPaths]
    : testdataPaths) {
    if (!fs.existsSync(testdataPath)) {
      continue;
    }
    for (const suiteEntry of fs.readdirSync(testdataPath, {
      withFileTypes: true,
    })) {
      const suitePath = path.join(testdataPath, suiteEntry.name);
      if (
        !isDirectory(suitePath, suiteEntry) ||
        !fs.existsSync(path.join(suitePath, "queries"))
      ) {
        continue;
      }
      for (const entry of fs.readdirSync(suitePath, { withFileTypes: true })) {
        const source = path.join(suitePath, entry.name);
        if (entry.name === "queries" || !isDirectory(source, entry)) {
          continue;
        }
        const name = `${suiteEntry.name}/${entry.name}`;
        if (discovered.has(name)) {
          continue;
        }
        discovered.add(name);
        datasets.push({ name, source });
      }
    }
  }
  return datasets;
}

export function selectDatasets(
  datasets: Dataset[],
  requested: string[],
): Dataset[] {
  if (requested.length === 0) {
    return datasets;
  }

  for (const dataset of requested) {
    datasetParts(dataset);
  }
  const byName = new Map(datasets.map((dataset) => [dataset.name, dataset]));
  const unknown = requested.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    const available =
      datasets.map((dataset) => dataset.name).join(", ") || "none";
    throw new Error(
      `Unknown dataset(s): ${unknown.join(", ")}. Available datasets: ${available}`,
    );
  }

  return [...new Set(requested)].map((name) => {
    const dataset = byName.get(name);
    if (!dataset) {
      throw new Error(`Unknown dataset '${name}'`);
    }
    return dataset;
  });
}

export function validateDatasetNames(datasets: string[]): string[] {
  if (datasets.length === 0) {
    throw new Error("Select at least one dataset");
  }
  for (const dataset of datasets) {
    datasetParts(dataset);
  }
  return [...new Set(datasets)];
}
