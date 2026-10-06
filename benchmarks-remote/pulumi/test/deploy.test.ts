import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const deployScript = path.resolve(__dirname, "../deploy.sh");

interface DeployStubs {
  configuredCidrs: string[];
  liveCidrs?: string[];
  allowedCidrs?: string;
}

// Runs deploy.sh against stub CLIs and returns the allowlist passed to `pulumi up`.
function allowlistForDeploy(stubs: DeployStubs): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-test-"));
  try {
    const capture = path.join(directory, "allowed-cidrs");
    const write = (name: string, script: string): void => {
      fs.writeFileSync(
        path.join(directory, name),
        `#!/usr/bin/env bash\n${script}`,
        {
          mode: 0o755,
        },
      );
    };
    write(
      "pulumi",
      `case "$1 $2" in
  "config get") echo '${JSON.stringify(stubs.configuredCidrs)}' ;;
  "stack output") ${stubs.liveCidrs ? "echo benchmark-cluster" : "exit 1"} ;;
  "up --stack") echo -n "$KUBERNETES_API_ALLOWED_CIDRS" >"${capture}"; exit 1 ;;
esac`,
    );
    write(
      "aws",
      `case " $* " in
  *" eks describe-cluster "*) echo '${JSON.stringify(stubs.liveCidrs ?? [])}' ;;
esac`,
    );
    write("curl", "echo 198.51.100.7");

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      PULUMI_BIN: path.join(directory, "pulumi"),
      PULUMI_BACKEND_URL: "",
    };
    delete environment.KUBERNETES_API_ALLOWED_CIDRS;
    if (stubs.allowedCidrs !== undefined) {
      environment.KUBERNETES_API_ALLOWED_CIDRS = stubs.allowedCidrs;
    }
    spawnSync("bash", [deployScript], { env: environment, stdio: "ignore" });
    return fs.readFileSync(capture, "utf8");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("deploy keeps CIDRs the cluster already allows", () => {
  assert.equal(
    allowlistForDeploy({
      configuredCidrs: ["192.0.2.10/32"],
      liveCidrs: ["203.0.113.5/32", "192.0.2.10/32", "0.0.0.0/0"],
    }),
    "192.0.2.10/32,198.51.100.7/32,203.0.113.5/32",
  );
});

test("first deploy combines configured CIDRs with the caller's IP", () => {
  assert.equal(
    allowlistForDeploy({ configuredCidrs: ["192.0.2.10/32"] }),
    "192.0.2.10/32,198.51.100.7/32",
  );
});

test("an explicit allowlist replaces the cluster's CIDRs", () => {
  assert.equal(
    allowlistForDeploy({
      configuredCidrs: ["192.0.2.10/32"],
      liveCidrs: ["203.0.113.5/32"],
      allowedCidrs: "192.0.2.20/32",
    }),
    "192.0.2.20/32",
  );
});
