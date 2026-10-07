import fs from "node:fs";
import path from "node:path";
import { message, object, option, optional, string } from "@optique/core";
import { runSync } from "@optique/run";
import {
  command,
  commonFlags,
  Environment,
  installTenancy,
  remoteRoot,
  value,
} from "../lib/operations";
import { foundationPaths, mergeCidrs } from "../lib/foundation";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
  stack: optional(
    option("--stack", string({ metavar: "NAME" }), {
      description: message`Pulumi stack (default: benchmark)`,
    }),
  ),
  "pulumi-bin": optional(
    option("--pulumi-bin", string({ metavar: "PATH" }), {
      description: message`Pulumi executable`,
    }),
  ),
  "backend-url": optional(
    option("--backend-url", string({ metavar: "URL" }), {
      description: message`Pulumi backend URL`,
    }),
  ),
  "secrets-provider": optional(
    option("--secrets-provider", string({ metavar: "URI" }), {
      description: message`Pulumi secrets provider (default: AWS KMS)`,
    }),
  ),
  "allowed-cidrs": optional(
    option("--allowed-cidrs", string({ metavar: "CIDRS" }), {
      description: message`Comma-separated Kubernetes API CIDRs`,
    }),
  ),
});
async function main(): Promise<void> {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy the benchmark foundation`,
  });
  const region = value(flags, "region", "us-east-1");
  const stack = value(flags, "stack", "benchmark");
  const files = foundationPaths(flags);
  const aws = (args: string[], allowFailure = false): string =>
    command("aws", ["--region", region, ...args], {
      capture: true,
      allowFailure,
      env: { AWS_PAGER: "" },
    });
  const pulumi = (args: string[], allowFailure = false): string =>
    command(value(flags, "pulumi-bin", "pulumi"), args, {
      cwd: path.join(remoteRoot, "pulumi"),
      capture: args[0] !== "up" && args[0] !== "destroy",
      allowFailure,
      env: { AWS_REGION: region },
    });
  aws(["sts", "get-caller-identity"]);
  if (flags["backend-url"]) pulumi(["login", value(flags, "backend-url")]);
  pulumi([
    "stack",
    "select",
    stack,
    "--create",
    "--secrets-provider",
    value(
      flags,
      "secrets-provider",
      `awskms://alias/datafusion-bench-pulumi-state?region=${region}`,
    ),
  ]);
  let cidrs: string[];
  if (flags["allowed-cidrs"])
    cidrs = value(flags, "allowed-cidrs")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  else {
    const response = await fetch("https://checkip.amazonaws.com");
    if (!response.ok)
      throw new Error(`Public IP lookup failed: ${response.status}`);
    const publicIp = (await response.text()).trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(publicIp))
      throw new Error("Invalid public IP response");
    const configured = JSON.parse(
      pulumi(["config", "get", "kubernetesApiAllowedCidrs", "--json"], true) ||
        "[]",
    ) as unknown;
    const cluster = pulumi(
      ["stack", "output", "clusterName", "--stack", stack],
      true,
    );
    const live = cluster
      ? (JSON.parse(
          aws(
            [
              "eks",
              "describe-cluster",
              "--name",
              cluster,
              "--query",
              "cluster.resourcesVpcConfig.publicAccessCidrs",
              "--output",
              "json",
            ],
            true,
          ) || "[]",
        ) as unknown)
      : [];
    cidrs = mergeCidrs(configured, live, publicIp);
  }
  pulumi([
    "config",
    "set",
    "kubernetesApiAllowedCidrs",
    JSON.stringify(cidrs),
    "--stack",
    stack,
  ]);
  pulumi(["up", "--stack", stack, "--yes"]);
  const outputs = pulumi(["stack", "output", "--stack", stack, "--json"]);
  JSON.parse(outputs);
  const temporary = `${files.outputs}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, outputs, { mode: 0o600 });
    fs.renameSync(temporary, files.outputs);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  installTenancy(
    new Environment({
      ...flags,
      "outputs-file": files.outputs,
      kubeconfig: files.kubeconfig,
      "refresh-kubeconfig": true,
    }),
  );
}
void main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
