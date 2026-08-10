#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
engine=${1:?usage: destroy-engine.sh ENGINE}
region=${AWS_REGION:-us-east-1}
outputs_file=${PULUMI_OUTPUTS_FILE:-${root}/benchmarks-remote/pulumi/.pulumi-outputs.json}

case ${engine} in
  datafusion | trino | spark | ballista) ;;
  *)
    echo "Unknown benchmark engine '${engine}'" >&2
    exit 2
    ;;
esac

if [[ ! -f ${outputs_file} ]]; then
  echo "Missing ${outputs_file}; run npm run foundation-deploy first" >&2
  exit 2
fi
cluster_name=$(jq -er '.clusterName' "${outputs_file}")
source "${root}/benchmarks-remote/k8s/lib.sh"
require_aws_credentials
ensure_kubeconfig

helm uninstall "${engine}" \
  --namespace "benchmark-${engine}" \
  --kube-context "${cluster_name}" \
  --ignore-not-found \
  --wait \
  --timeout 10m
echo "Destroyed ${engine}; EKS Auto Mode will terminate its empty nodes"
