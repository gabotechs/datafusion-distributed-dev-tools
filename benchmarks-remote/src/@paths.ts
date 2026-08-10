import fs from "fs";
import path from "path";

/** Root of the development-tools checkout. */
export const DEV_TOOLS_ROOT = path.resolve(__dirname, "../..");

/**
 * The source checkout intentionally lives beside this repository:
 *
 *   <parent>/datafusion-distributed-dev-tools
 *   <parent>/datafusion-distributed
 */
export const DEFAULT_DATAFUSION_DISTRIBUTED_ROOT = path.resolve(
    DEV_TOOLS_ROOT,
    "../datafusion-distributed",
);

export function datafusionDistributedRoot(): string {
    const configured = process.env.DATAFUSION_DISTRIBUTED_ROOT;
    return configured
        ? path.resolve(DEV_TOOLS_ROOT, configured)
        : DEFAULT_DATAFUSION_DISTRIBUTED_ROOT;
}

export function datasetParts(dataset: string): [string, string] {
    const match = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/.exec(dataset);
    if (!match) {
        throw new Error(`Invalid dataset '${dataset}'; expected a path such as tpch/sf10`);
    }
    return [match[1], match[2]];
}

export function testdataRoots(): string[] {
    if (process.env.BENCHMARK_TESTDATA_ROOT) {
        return [path.resolve(process.env.BENCHMARK_TESTDATA_ROOT)];
    }

    return [path.join(datafusionDistributedRoot(), "testdata")];
}

export function datasetPath(dataset: string): string {
    const relative = path.join(...datasetParts(dataset));
    const roots = testdataRoots();
    return roots.map(root => path.join(root, relative)).find(candidate => fs.existsSync(candidate))
        ?? path.join(roots[0], relative);
}
