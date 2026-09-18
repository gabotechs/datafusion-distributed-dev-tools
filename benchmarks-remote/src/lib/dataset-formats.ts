interface DatasetFormat {
  readonly fileType: string;
  readonly entryPoint: string;
  matches(entries: readonly string[]): boolean;
}

const formats: readonly DatasetFormat[] = [
  {
    fileType: "ICEBERG",
    entryPoint: "metadata.json",
    matches: (entries) =>
      entries.includes("metadata.json") || entries.includes("metadata/"),
  },
  {
    fileType: "PARQUET",
    entryPoint: "",
    matches: (entries) =>
      entries.length > 0 &&
      entries.every((entry) => entry.endsWith(".parquet")),
  },
];

// S3 common prefixes end in '/'.
export type ReadDirectory = (directory: string) => Promise<string[]>;

export interface DatasetTable {
  name: string;
  format: DatasetFormat;
}

export async function discoverDatasetTables(
  directory: string,
  readDirectory: ReadDirectory,
): Promise<DatasetTable[]> {
  const tables: DatasetTable[] = [];
  for (const entry of await readDirectory(directory)) {
    if (!entry.endsWith("/") || entry.startsWith(".")) continue;
    const name = entry.slice(0, -1);
    const entries = await readDirectory(`${directory}/${name}`);
    const format = formats.find((candidate) => candidate.matches(entries));
    if (!format) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid table name '${name}'`);
    }
    tables.push({ name, format });
  }
  return tables;
}
