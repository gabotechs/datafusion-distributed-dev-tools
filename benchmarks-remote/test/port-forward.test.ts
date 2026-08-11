import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withKubectlPortForward } from "../src/lib/port-forward";

test("starts and stops kubectl after its port-forward is ready", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "port-forward-"));
  const kubectl = path.join(directory, "kubectl");
  const kubeconfig = path.join(directory, "kubeconfig");
  fs.writeFileSync(
    kubectl,
    `#!/usr/bin/env node
if (process.argv.includes("config")) {
  process.stdout.write("cluster\\n");
  process.exit(0);
}
process.stdout.write("Forwarding from 127.0.0.1:9000 -> 9000\\n");
setInterval(() => {}, 1_000);
`,
  );
  fs.chmodSync(kubectl, 0o755);
  fs.writeFileSync(kubeconfig, "");

  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
  try {
    assert.equal(
      await withKubectlPortForward(
        {
          clusterName: "cluster",
          deployment: "datafusion",
          service: "datafusion-job-7",
          region: "us-east-1",
          kubeconfig,
        },
        async () => "completed",
      ),
      "completed",
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("instructs the user when kubeconfig setup is required", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "port-forward-"));

  try {
    await assert.rejects(
      withKubectlPortForward(
        {
          clusterName: "cluster",
          deployment: "datafusion",
          service: "datafusion",
          region: "us-east-1",
          kubeconfig: path.join(directory, "missing-kubeconfig"),
        },
        async () => undefined,
      ),
      /Run aws eks update-kubeconfig.*cluster 'cluster'.*region 'us-east-1'/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
