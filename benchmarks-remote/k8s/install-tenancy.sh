#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"
init_environment

ensure_kubeconfig
HELM_CACHE_HOME=/tmp/datafusion-distributed-helm-cache \
  HELM_CONFIG_HOME=/tmp/datafusion-distributed-helm-config \
  HELM_DATA_HOME=/tmp/datafusion-distributed-helm-data \
  helm upgrade --install benchmark-tenancy \
  "${root}/benchmarks-remote/k8s/benchmark-tenancy" \
  --kube-context "${cluster_name}" \
  --rollback-on-failure \
  --cleanup-on-fail \
  --wait \
  --timeout 10m

echo "Installed benchmark tenancy on EKS cluster ${cluster_name}"
