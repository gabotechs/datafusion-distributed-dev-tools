#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"
init_environment

dataset_bucket=$(jq -er '.datasetBucketName' "${outputs_file}")

ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-${TMPDIR:-/tmp}/datafusion-distributed-zig-global} \
ZIG_LOCAL_CACHE_DIR=${ZIG_LOCAL_CACHE_DIR:-${TMPDIR:-/tmp}/datafusion-distributed-zig-ballista} \
CARGO_HOME=${CARGO_HOME:-${TMPDIR:-/tmp}/datafusion-distributed-ballista-cargo-home} \
  cargo zigbuild \
  --manifest-path "${root}/benchmarks-remote/engines/ballista/Cargo.toml" \
  --release \
  --target x86_64-unknown-linux-gnu
target="${root}/benchmarks-remote/engines/ballista/target/x86_64-unknown-linux-gnu/release"
artifacts='{}'
for binary in ballista-scheduler ballista-executor ballista-http; do
  sha=$(shasum -a 256 "${target}/${binary}" | awk '{print $1}')
  key=".benchmark-artifacts/ballista/${sha}/${binary}"
  if ! aws_cli s3api head-object --bucket "${dataset_bucket}" --key "${key}" >/dev/null 2>&1; then
    aws_cli s3 cp "${target}/${binary}" "s3://${dataset_bucket}/${key}"
  fi
  artifacts=$(jq --arg binary "${binary}" --arg uri "s3://${dataset_bucket}/${key}" \
    '.[$binary] = $uri' <<<"${artifacts}")
done
update_runtime_file '.ballistaArtifacts = $artifacts' --argjson artifacts "${artifacts}"
echo "Published Ballista binaries"
