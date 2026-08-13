#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"
init_environment

dataset_bucket=$(jq -er '.datasetBucketName' "${outputs_file}")
artifact_bucket=${WORKER_ARTIFACT_BUCKET:-${dataset_bucket}}
artifact_prefix=${WORKER_ARTIFACT_PREFIX:-.benchmark-artifacts/datafusion}
source_root=${DATAFUSION_SOURCE_ROOT:-${root}/../datafusion-distributed}

if [[ -n ${DATAFUSION_BUILD_WRAPPER:-} ]]; then
  sudo "${DATAFUSION_BUILD_WRAPPER}"
else
  ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-${TMPDIR:-/tmp}/datafusion-distributed-zig-global} \
  ZIG_LOCAL_CACHE_DIR=${ZIG_LOCAL_CACHE_DIR:-${TMPDIR:-/tmp}/datafusion-distributed-zig-local} \
    cargo zigbuild \
    --manifest-path "${source_root}/benchmarks/Cargo.toml" \
    --package datafusion-distributed-benchmarks \
    --release \
    --bin worker \
    --target x86_64-unknown-linux-gnu
fi

target_dir=${CARGO_TARGET_DIR:-${source_root}/target}
worker_binary="${target_dir}/x86_64-unknown-linux-gnu/release/worker"
binary_sha=$(shasum -a 256 "${worker_binary}" | awk '{print $1}')
artifact_key="${artifact_prefix}/${binary_sha}/worker"
artifact="s3://${artifact_bucket}/${artifact_key}"
if ! aws_cli s3api head-object \
  --bucket "${artifact_bucket}" \
  --key "${artifact_key}" >/dev/null 2>&1; then
  aws_cli s3 cp "${worker_binary}" "${artifact}"
fi

update_runtime_file \
  '.workerArtifact = $workerArtifact | .workerBinarySha = $workerBinarySha' \
  --arg workerArtifact "${artifact}" \
  --arg workerBinarySha "${binary_sha}"
echo "Published ${artifact}"
