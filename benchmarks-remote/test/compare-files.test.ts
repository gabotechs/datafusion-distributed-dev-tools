import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {compareStoredResults} from "../src/@compare";
import {BenchResult} from "../src/@results";

function storeResult(dataset: string, engine: string, query: string, elapsed: number): void {
    const result = new BenchResult(dataset, engine, query);
    result.iterations.push({elapsed, plan: "", rowCount: 1, tasks: 1});
    result.store();
}

test("builds comparisons from stored per-query result files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-file-compare-"));
    const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
    process.env.BENCHMARK_TESTDATA_ROOT = root;
    fs.mkdirSync(path.join(root, "tpch", "sf1"), {recursive: true});

    try {
        storeResult("tpch/sf1", "base", "q1", 100);
        storeResult("tpch/sf1", "head", "q1", 90);

        const comparison = compareStoredResults("tpch/sf1", "base", "head");
        assert.match(comparison, /^=== Comparing tpch\/sf1 results/);
        assert.match(comparison, /q1: prev= 100 ms, new=  90 ms/);
        assert.match(comparison, /TOTAL: prev=100 ms, new=90 ms/);
    } finally {
        if (previousRoot === undefined) delete process.env.BENCHMARK_TESTDATA_ROOT;
        else process.env.BENCHMARK_TESTDATA_ROOT = previousRoot;
        fs.rmSync(root, {recursive: true, force: true});
    }
});
test("rejects incomplete stored comparisons", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-file-compare-"));
    const previousRoot = process.env.BENCHMARK_TESTDATA_ROOT;
    process.env.BENCHMARK_TESTDATA_ROOT = root;
    fs.mkdirSync(path.join(root, "tpch", "sf1"), {recursive: true});

    try {
        storeResult("tpch/sf1", "base", "q1", 100);
        storeResult("tpch/sf1", "head", "q2", 90);
        assert.throws(
            () => compareStoredResults("tpch/sf1", "base", "head"),
            /Stored query sets differ/,
        );
    } finally {
        if (previousRoot === undefined) delete process.env.BENCHMARK_TESTDATA_ROOT;
        else process.env.BENCHMARK_TESTDATA_ROOT = previousRoot;
        fs.rmSync(root, {recursive: true, force: true});
    }
});
