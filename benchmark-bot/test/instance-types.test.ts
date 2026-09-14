import assert from "node:assert/strict";
import test from "node:test";

import {
  SUPPORTED_BENCHMARK_INSTANCE_TYPES,
  benchmarkWorkerResources,
} from "../src/instance-types.js";

test("derives node-filling worker resources for every supported instance", () => {
  assert.deepEqual(SUPPORTED_BENCHMARK_INSTANCE_TYPES, [
    "c5n.2xlarge",
    "c5n.4xlarge",
    "m5.2xlarge",
    "m5.4xlarge",
    "r5.2xlarge",
    "r5.4xlarge",
  ]);
  assert.deepEqual(benchmarkWorkerResources("c5n.2xlarge"), {
    cpu: "7",
    memory: "17Gi",
  });
  assert.deepEqual(benchmarkWorkerResources("c5n.4xlarge"), {
    cpu: "15",
    memory: "38Gi",
  });
  assert.deepEqual(benchmarkWorkerResources("m5.2xlarge"), {
    cpu: "7",
    memory: "28Gi",
  });
  assert.deepEqual(benchmarkWorkerResources("m5.4xlarge"), {
    cpu: "15",
    memory: "60Gi",
  });
  assert.deepEqual(benchmarkWorkerResources("r5.2xlarge"), {
    cpu: "7",
    memory: "60Gi",
  });
  assert.deepEqual(benchmarkWorkerResources("r5.4xlarge"), {
    cpu: "15",
    memory: "124Gi",
  });
  assert.equal(benchmarkWorkerResources("c7i.2xlarge"), undefined);
});
