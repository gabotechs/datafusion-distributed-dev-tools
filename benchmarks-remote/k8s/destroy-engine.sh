#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"

engine=${1:?usage: destroy-engine.sh ENGINE}
validate_engine "${engine}"
init_environment
deployment_name=${DEPLOYMENT_NAME:-${engine}}
validate_deployment_name "${deployment_name}"
require_aws_credentials
ensure_kubeconfig

helm uninstall "${deployment_name}" \
  --namespace "benchmark-${engine}" \
  --kube-context "${cluster_name}" \
  --ignore-not-found \
  --wait \
  --timeout 10m
echo "Destroyed ${deployment_name}; EKS Auto Mode will terminate its empty nodes"
