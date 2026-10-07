import fs from "node:fs";
import path from "node:path";
import { message, object, option, optional, string } from "@optique/core";
import { runSync } from "@optique/run";
import { command, commonFlags, remoteRoot, value } from "../lib/operations";
import { foundationPaths } from "../lib/foundation";
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
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Destroy the benchmark foundation`,
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
  pulumi(["stack", "select", stack]);
  pulumi(["state", "unprotect", "--stack", stack, "--all", "--yes"]);
  pulumi(["destroy", "--stack", stack, "--yes"]);
  for (const file of [files.outputs, files.kubeconfig])
    fs.rmSync(file, { force: true });
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
