#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"
init_environment

dataset_bucket=$(jq -er '.datasetBucketName' "${outputs_file}")

ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-${TMPDIR:-/tmp}/datafusion-distributed-zig-global} \
ZIG_LOCAL_CACHE_DIR=${ZIG_LOCAL_CACHE_DIR:-${TMPDIR:-/tmp}/datafusion-distributed-zig-local} \
  cargo zigbuild \
  --manifest-path "${root}/benchmarks-remote/engines/datafusion/Cargo.toml" \
  --package datafusion-distributed-benchmark-worker \
  --release \
  --bin worker \
  --target x86_64-unknown-linux-gnu

worker_binary="${root}/benchmarks-remote/engines/datafusion/target/x86_64-unknown-linux-gnu/release/worker"
binary_sha=$(shasum -a 256 "${worker_binary}" | awk '{print $1}')
artifact="s3://${dataset_bucket}/.benchmark-artifacts/datafusion/${binary_sha}/worker"
if ! aws_cli s3api head-object \
  --bucket "${dataset_bucket}" \
  --key ".benchmark-artifacts/datafusion/${binary_sha}/worker" >/dev/null 2>&1; then
  aws_cli s3 cp "${worker_binary}" "${artifact}"
fi

update_runtime_file \
  '.workerArtifact = $workerArtifact | .workerBinarySha = $workerBinarySha' \
  --arg workerArtifact "${artifact}" \
  --arg workerBinarySha "${binary_sha}"
echo "Published ${artifact}"
