import path from "node:path";
import { engines, command, remoteRoot } from "../lib/operations";
import { argument, choice, message, object, optional } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  selectedChart: optional(argument(choice([...engines, "benchmark-tenancy"]))),
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Lint and render benchmark charts`,
  });
  const { selectedChart } = flags;

  for (const engine of selectedChart
    ? [selectedChart]
    : [...engines, "benchmark-tenancy"]) {
    const chart = path.join(remoteRoot, "k8s", engine);
    const values =
      engine === "benchmark-tenancy"
        ? []
        : ["--values", path.join(remoteRoot, "k8s/worker-resources.yaml")];
    if (engine === "spark") values.push("--set", "image=test/spark:latest");
    if (engine === "trino" || engine === "ballista")
      values.push("--set", "datasetBucket=test-datasets");
    if (engine === "datafusion")
      values.push(
        "--set",
        "worker.artifact=s3://test-datasets/artifacts/worker",
        "--set",
        "worker.datasetBucket=test-datasets",
      );
    if (engine === "ballista")
      values.push(
        "--set",
        "artifacts.scheduler=s3://test/scheduler",
        "--set",
        "artifacts.executor=s3://test/executor",
        "--set",
        "artifacts.http=s3://test/http",
      );
    command("helm", ["lint", chart, ...values]);
    const rendered = command(
      "helm",
      ["template", "benchmark", chart, ...values],
      { capture: true },
    );
    if (engine === "benchmark-tenancy") {
      for (const name of [
        "datafusion",
        "trino",
        "spark",
        "ballista",
        "clickhouse",
      ])
        if (
          !rendered.includes(`name: benchmark-${name}`) ||
          !rendered.includes(`benchmark.datafusion.apache.org/engine: ${name}`)
        )
          throw new Error(`Missing tenancy for ${name}`);
      if (
        /^kind: (Role|RoleBinding|ClusterRole|ClusterRoleBinding)$/m.test(
          rendered,
        )
      )
        throw new Error(
          "Local benchmark runners must not require in-cluster RBAC",
        );
    }
  }
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
