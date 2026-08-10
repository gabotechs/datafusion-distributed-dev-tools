import assert from "node:assert/strict";
import test from "node:test";

import { BenchmarkRun, BenchResult } from "../src/@results";

function result(engine: string, elapsed: number): BenchResult {
    const value = new BenchResult("tpch/sf1", engine, "q1");
    value.iterations.push({
        elapsed,
        plan: "",
        rowCount: 1,
        tasks: 1,
    });
    return value;
}

function output(operation: () => void): string[] {
    const lines: string[] = [];
    const previousLog = console.log;
    console.log = (message?: unknown) => lines.push(String(message));
    try {
        operation();
        return lines;
    } finally {
        console.log = previousLog;
    }
}

test("highlights individual queries at 1.5x", () => {
    const normalRegression = output(() =>
        result("head", 149).compare(result("base", 100)),
    );
    const highlightedRegression = output(() =>
        result("head", 150).compare(result("base", 100)),
    );
    const highlightedImprovement = output(() =>
        result("head", 100).compare(result("base", 150)),
    );

    assert.match(normalRegression[0]!, /1\.49 slower ✖$/);
    assert.match(highlightedRegression[0]!, /1\.50 slower ❌$/);
    assert.match(highlightedImprovement[0]!, /1\.50 faster ✅$/);
});

test("highlights aggregate totals at 1.1x and prints TOTAL last", () => {
    const base = new BenchmarkRun("tpch/sf1", "base");
    base.results.push(result("base", 100));

    const normalHead = new BenchmarkRun("tpch/sf1", "head");
    normalHead.results.push(result("head", 109));
    const normal = output(() => normalHead.compare(base));

    const highlightedHead = new BenchmarkRun("tpch/sf1", "head");
    highlightedHead.results.push(result("head", 110));
    const highlighted = output(() => highlightedHead.compare(base));

    assert.match(normal.at(-1)!, /1\.09 slower ✖$/);
    assert.match(highlighted.at(-1)!, /1\.10 slower ❌$/);
    assert.match(highlighted[0]!, /^=== Comparing tpch\/sf1/);
    assert.match(highlighted.at(-1)!, /^\s*TOTAL:/);
});
