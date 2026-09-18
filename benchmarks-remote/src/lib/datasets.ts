import { datasetParts } from "./paths";

export function validateDatasetNames(datasets: string[]): string[] {
  if (datasets.length === 0) {
    throw new Error("Select at least one dataset");
  }
  for (const dataset of datasets) {
    datasetParts(dataset);
  }
  return [...new Set(datasets)];
}
