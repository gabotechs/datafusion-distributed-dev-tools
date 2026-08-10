#!/usr/bin/env bash

k8s_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export KUBECONFIG=${KUBECONFIG:-${k8s_dir}/.kubeconfig}

aws_cli() {
  AWS_PAGER='' aws --region "${region}" "$@"
}

require_aws_credentials() {
  if ! aws_cli sts get-caller-identity >/dev/null; then
    echo "AWS credentials are missing or expired; select AWS_PROFILE and run aws sso login" >&2
    return 1
  fi
}

ensure_kubeconfig() {
  if [[ ${REFRESH_KUBECONFIG:-false} != true && -f ${KUBECONFIG} ]] && \
    [[ $(kubectl config get-contexts "${cluster_name}" -o name 2>/dev/null) == "${cluster_name}" ]]; then
    return
  fi
  aws_cli eks update-kubeconfig \
    --name "${cluster_name}" \
    --alias "${cluster_name}" \
    --kubeconfig "${KUBECONFIG}" >/dev/null
}

kubectl_cli() {
  kubectl --context "${cluster_name}" "$@"
}
