import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flag, message, option, optional, string } from "@optique/core";
import { DEV_TOOLS_ROOT } from "./paths";

export const remoteRoot = path.join(DEV_TOOLS_ROOT, "benchmarks-remote");
export const engines = [
  "datafusion",
  "trino",
  "spark",
  "ballista",
  "clickhouse",
] as const;
export type Engine = (typeof engines)[number];
export type Flags = Record<string, string | boolean | undefined>;
export const commonFlags = {
  region: optional(
    option("--region", string({ metavar: "VALUE" }), {
      description: message`AWS region (default: us-east-1)`,
    }),
  ),
  "outputs-file": optional(
    option("--outputs-file", string({ metavar: "VALUE" }), {
      description: message`Foundation outputs JSON file`,
    }),
  ),
  kubeconfig: optional(
    option("--kubeconfig", string({ metavar: "VALUE" }), {
      description: message`Kubernetes configuration file`,
    }),
  ),
  "refresh-kubeconfig": flag("--refresh-kubeconfig", {
    description: message`Refresh Kubernetes credentials`,
  }).withDefault(false),
};
export const publishingFlags = {
  "source-root": optional(
    option("--source-root", string({ metavar: "VALUE" }), {
      description: message`DataFusion Distributed source checkout`,
    }),
  ),
  "target-dir": optional(
    option("--target-dir", string({ metavar: "VALUE" }), {
      description: message`Cargo target directory`,
    }),
  ),
  "build-wrapper": optional(
    option("--build-wrapper", string({ metavar: "VALUE" }), {
      description: message`Privileged isolated build wrapper`,
    }),
  ),
  "artifact-bucket": optional(
    option("--artifact-bucket", string({ metavar: "VALUE" }), {
      description: message`Worker artifact bucket`,
    }),
  ),
  "artifact-prefix": optional(
    option("--artifact-prefix", string({ metavar: "VALUE" }), {
      description: message`Worker artifact key prefix`,
    }),
  ),
};
export function value(flags: Flags, name: string, fallback?: string): string {
  const result = flags[name] ?? fallback;
  if (typeof result !== "string" || result.length === 0)
    throw new Error(`Missing --${name}`);
  return result;
}
export function deploymentName(
  engine: Engine,
  name = `${engine}-${(process.env.USER || os.userInfo().username).replaceAll(".", "-")}`,
): string {
  if (name.length > 53 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name))
    throw new Error(`Invalid deployment name '${name}'`);
  return name;
}
export function workerSelector(engine: Engine): string {
  if (engine === "datafusion")
    return "app.kubernetes.io/name=datafusion-worker";
  return `app.kubernetes.io/name=${engine},app.kubernetes.io/component=${engine === "ballista" ? "executor" : "worker"}`;
}
export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
  stderr?: boolean;
  allowFailure?: boolean;
}
export function command(
  program: string,
  args: string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(program, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture
      ? ["ignore", "pipe", "pipe"]
      : options.stderr
        ? ["inherit", 2, 2]
        : ["inherit", "inherit", "inherit"],
  });
  if (!options.allowFailure && (result.error || result.status !== 0))
    throw new Error(
      `${program} failed: ${result.error?.message ?? result.stderr ?? result.signal ?? result.status}`,
    );
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}
export class Environment {
  readonly region: string;
  readonly kubeconfig: string;
  readonly outputs: Record<string, unknown>;
  constructor(readonly flags: Flags) {
    this.region = value(flags, "region", "us-east-1");
    this.kubeconfig = path.resolve(
      value(flags, "kubeconfig", path.join(remoteRoot, "k8s/.kubeconfig")),
    );
    const file = value(
      flags,
      "outputs-file",
      path.join(remoteRoot, "pulumi/.pulumi-outputs.json"),
    );
    this.outputs = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
  }
  output(name: string): string {
    const result = this.outputs[name];
    if (
      (typeof result !== "string" && typeof result !== "number") ||
      result === ""
    )
      throw new Error(`Missing foundation output ${name}`);
    return String(result);
  }
  aws(args: string[], options: CommandOptions = {}): string {
    return command("aws", ["--region", this.region, ...args], {
      ...options,
      env: { ...options.env, AWS_PAGER: "" },
    });
  }
  credentials(): void {
    this.aws(["sts", "get-caller-identity"], { capture: true });
  }
  kubectl(args: string[], options: CommandOptions = {}): string {
    return command(
      "kubectl",
      ["--context", this.output("clusterName"), ...args],
      { ...options, env: { KUBECONFIG: this.kubeconfig } },
    );
  }
  ensureKubeconfig(): void {
    const cluster = this.output("clusterName");
    if (
      !this.flags["refresh-kubeconfig"] &&
      fs.existsSync(this.kubeconfig) &&
      command("kubectl", ["config", "get-contexts", cluster, "-o", "name"], {
        env: { KUBECONFIG: this.kubeconfig },
        capture: true,
        allowFailure: true,
      }) === cluster
    )
      return;
    this.aws(
      [
        "eks",
        "update-kubeconfig",
        "--name",
        cluster,
        "--alias",
        cluster,
        "--kubeconfig",
        this.kubeconfig,
      ],
      { capture: true },
    );
  }
  helm(args: string[]): void {
    command("helm", [...args, "--kube-context", this.output("clusterName")], {
      env: {
        KUBECONFIG: this.kubeconfig,
        HELM_CACHE_HOME: path.join(
          os.tmpdir(),
          "datafusion-distributed-helm-cache",
        ),
        HELM_CONFIG_HOME: path.join(
          os.tmpdir(),
          "datafusion-distributed-helm-config",
        ),
        HELM_DATA_HOME: path.join(
          os.tmpdir(),
          "datafusion-distributed-helm-data",
        ),
      },
    });
  }
}
export function installTenancy(env: Environment): void {
  env.ensureKubeconfig();
  env.helm([
    "upgrade",
    "--install",
    "benchmark-tenancy",
    path.join(remoteRoot, "k8s/benchmark-tenancy"),
    "--rollback-on-failure",
    "--cleanup-on-fail",
    "--wait",
    "--timeout",
    "10m",
  ]);
}
