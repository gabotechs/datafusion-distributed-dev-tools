import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { command, type Environment, remoteRoot, value } from "./operations";
import { DEFAULT_DATAFUSION_DISTRIBUTED_ROOT } from "./paths";

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function publishBinary(
  env: Environment,
  file: string,
  bucket: string,
  prefix: string,
): string {
  const key = `${prefix}/${sha256(file)}/${path.basename(file)}`;
  const uri = `s3://${bucket}/${key}`;
  if (
    !env.aws(["s3api", "head-object", "--bucket", bucket, "--key", key], {
      capture: true,
      allowFailure: true,
    })
  )
    env.aws(["s3", "cp", file, uri], { stderr: true });
  console.error(`Published ${uri}`);
  return uri;
}
export function publishDatafusion(env: Environment): string {
  const source = path.resolve(
    value(env.flags, "source-root", DEFAULT_DATAFUSION_DISTRIBUTED_ROOT),
  );
  const target = path.resolve(
    value(env.flags, "target-dir", path.join(source, "target")),
  );
  const wrapper = env.flags["build-wrapper"];
  if (typeof wrapper === "string") command("sudo", [wrapper], { stderr: true });
  else
    command(
      "cargo",
      [
        "zigbuild",
        "--manifest-path",
        path.join(source, "benchmarks/remote-worker/Cargo.toml"),
        "--package",
        "datafusion-distributed-remote-worker",
        "--release",
        "--bin",
        "worker",
        "--target",
        "x86_64-unknown-linux-gnu",
      ],
      {
        stderr: true,
        env: {
          CARGO_TARGET_DIR: target,
          ZIG_GLOBAL_CACHE_DIR:
            process.env.ZIG_GLOBAL_CACHE_DIR ??
            path.join(os.tmpdir(), "datafusion-distributed-zig-global"),
          ZIG_LOCAL_CACHE_DIR:
            process.env.ZIG_LOCAL_CACHE_DIR ??
            path.join(os.tmpdir(), "datafusion-distributed-zig-local"),
        },
      },
    );
  return publishBinary(
    env,
    path.join(target, "x86_64-unknown-linux-gnu/release/worker"),
    value(env.flags, "artifact-bucket", env.output("datasetBucketName")),
    value(env.flags, "artifact-prefix", ".benchmark-artifacts/datafusion"),
  );
}
export function publishBallista(env: Environment): Record<string, string> {
  const source = path.join(remoteRoot, "engines/ballista");
  const target = path.resolve(
    value(env.flags, "target-dir", path.join(source, "target")),
  );
  command(
    "cargo",
    [
      "zigbuild",
      "--manifest-path",
      path.join(source, "Cargo.toml"),
      "--release",
      "--target",
      "x86_64-unknown-linux-gnu",
    ],
    {
      stderr: true,
      env: {
        CARGO_TARGET_DIR: target,
        ZIG_GLOBAL_CACHE_DIR:
          process.env.ZIG_GLOBAL_CACHE_DIR ??
          path.join(os.tmpdir(), "datafusion-distributed-zig-global"),
        ZIG_LOCAL_CACHE_DIR:
          process.env.ZIG_LOCAL_CACHE_DIR ??
          path.join(os.tmpdir(), "datafusion-distributed-zig-ballista"),
        CARGO_HOME:
          process.env.CARGO_HOME ??
          path.join(os.tmpdir(), "datafusion-distributed-ballista-cargo-home"),
      },
    },
  );
  return Object.fromEntries(
    ["ballista-scheduler", "ballista-executor", "ballista-http"].map(
      (binary) => [
        binary,
        publishBinary(
          env,
          path.join(target, "x86_64-unknown-linux-gnu/release", binary),
          env.output("datasetBucketName"),
          ".benchmark-artifacts/ballista",
        ),
      ],
    ),
  );
}
export async function publishImage(
  env: Environment,
  engine: string,
): Promise<string> {
  if (engine !== "spark")
    throw new Error(`No container image publisher is defined for ${engine}`);
  const context = path.join(remoteRoot, "engines/spark");
  const files = ["Dockerfile", "spark_http.py"];
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(
      `${sha256(path.join(context, file))}  ${path.join(context, file)}\n`,
    );
  const tag = hash.digest("hex").slice(0, 24);
  const repositories = env.outputs.repositoryUrls as
    Record<string, string> | undefined;
  const repository = repositories?.spark;
  if (!repository) throw new Error("Missing Spark repository URL");
  const image = `${repository}:${tag}`;
  const exists = (): boolean =>
    Boolean(
      env.aws(
        [
          "ecr",
          "describe-images",
          "--repository-name",
          repository.slice(repository.indexOf("/") + 1),
          "--image-ids",
          `imageTag=${tag}`,
        ],
        { capture: true, allowFailure: true },
      ),
    );
  if (!exists()) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark-image-"));
    try {
      const archive = path.join(directory, "context.tar.gz");
      command("tar", ["-czf", archive, "-C", context, ...files], {
        env: { COPYFILE_DISABLE: "1" },
      });
      const artifact = `s3://${env.output("resultsBucketName")}/runs/bootstrap/images/${engine}-${tag}.tar.gz`;
      env.aws(["s3", "cp", archive, artifact], { stderr: true });
      const build = env.aws(
        [
          "codebuild",
          "start-build",
          "--project-name",
          env.output("imageBuilderProjectName"),
          "--environment-variables-override",
          `name=BUILD_CONTEXT,value=${artifact},type=PLAINTEXT`,
          `name=IMAGE_URI,value=${image},type=PLAINTEXT`,
          "--query",
          "build.id",
          "--output",
          "text",
        ],
        { capture: true },
      );
      for (let attempt = 0; ; attempt++) {
        const status = env.aws(
          [
            "codebuild",
            "batch-get-builds",
            "--ids",
            build,
            "--query",
            "builds[0].buildStatus",
            "--output",
            "text",
          ],
          { capture: true },
        );
        if (status === "SUCCEEDED") break;
        if (["FAILED", "FAULT", "STOPPED", "TIMED_OUT"].includes(status)) {
          if (exists()) break;
          env.aws(["codebuild", "batch-get-builds", "--ids", build], {
            stderr: true,
          });
          throw new Error(`CodeBuild ${build} ${status}`);
        }
        if (attempt === 239)
          throw new Error(`Timed out waiting for CodeBuild build ${build}`);
        await setTimeout(5000);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  console.error(`Published ${image}`);
  return image;
}
