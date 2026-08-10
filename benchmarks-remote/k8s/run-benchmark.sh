#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"

engine=${1:?usage: run-benchmark.sh ENGINE [benchmark options]}
shift
validate_engine "${engine}"
init_environment
dataset_bucket=$(jq -er '.datasetBucketName' "${outputs_file}")

namespace="benchmark-${engine}"

ensure_kubeconfig

port_forward_pid=
port_forward_log=$(mktemp)
cleanup() {
  local exit_code=$?
  trap - EXIT
  trap '' INT TERM HUP
  set +e
  [[ -z ${port_forward_pid} ]] || kill "${port_forward_pid}" 2>/dev/null
  [[ -z ${port_forward_pid} ]] || wait "${port_forward_pid}" 2>/dev/null
  rm -f -- "${port_forward_log}"
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM HUP

service_name=${BENCHMARK_SERVICE_NAME:-${engine}}
kubectl --context "${cluster_name}" port-forward \
  --namespace "${namespace}" \
  "service/${service_name}" \
  "9000:9000" >"${port_forward_log}" 2>&1 &
port_forward_pid=$!
until grep -q '^Forwarding from ' "${port_forward_log}"; do
  if ! kill -0 "${port_forward_pid}" 2>/dev/null; then
    cat "${port_forward_log}" >&2
    wait "${port_forward_pid}" || true
    exit 1
  fi
  sleep 0.1
done

cd "${root}/benchmarks-remote"
# pr-bot/src/executor.ts sets BENCHMARK_RUNNER, BENCHMARK_SERVICE_NAME, and
# BENCHMARK_TESTDATA_ROOT when it invokes this trusted harness for an isolated job.
if [[ -n ${BENCHMARK_RUNNER:-} ]]; then
  env "BENCHMARK_BUCKET=s3://${dataset_bucket}" node "${BENCHMARK_RUNNER}" "$@"
else
  env "BENCHMARK_BUCKET=s3://${dataset_bucket}" npm run "runner:${engine}-bench" -- "$@"
fi

echo "Benchmark run completed" >&2
