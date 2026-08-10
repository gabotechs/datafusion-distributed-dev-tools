import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
    DATAFUSION_DISTRIBUTED_ROOT,
    DEV_TOOLS_ROOT,
    testdataRoots,
} from "../src/@paths";

test("uses the sibling DataFusion Distributed checkout for testdata", () => {
    assert.equal(
        DATAFUSION_DISTRIBUTED_ROOT,
        path.resolve(DEV_TOOLS_ROOT, "../datafusion-distributed"),
    );
    assert.deepEqual(testdataRoots(), [
        path.join(DATAFUSION_DISTRIBUTED_ROOT, "testdata"),
    ]);
});
