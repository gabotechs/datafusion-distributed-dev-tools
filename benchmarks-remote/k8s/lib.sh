#!/usr/bin/env bash

k8s_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

init_environment() {
  root=$(cd "${k8s_dir}/../.." && pwd)
  region=${AWS_REGION:-us-east-1}
  outputs_file=${PULUMI_OUTPUTS_FILE:-${root}/benchmarks-remote/pulumi/.pulumi-outputs.json}
  export KUBECONFIG=${KUBECONFIG:-${k8s_dir}/.kubeconfig}

  if [[ ! -f ${outputs_file} ]]; then
    echo "Missing ${outputs_file}; run npm run foundation-deploy first" >&2
    return 2
  fi
  cluster_name=$(jq -er '.clusterName' "${outputs_file}")
}

validate_engine() {
  local engine=$1
  case ${engine} in
    datafusion | trino | spark | ballista) ;;
    *)
      echo "Unknown benchmark engine '${engine}'" >&2
      return 2
      ;;
  esac
}

validate_deployment_name() {
  local name=$1
  if [[ ${#name} -gt 53 || ! ${name} =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    echo "Invalid deployment name '${name}'" >&2
    return 2
  fi
}

benchmark_worker_selector() {
  local engine=$1
  validate_engine "${engine}" || return
  case ${engine} in
    datafusion) echo 'app.kubernetes.io/name=datafusion-worker' ;;
    trino | spark) echo "app.kubernetes.io/name=${engine},app.kubernetes.io/component=worker" ;;
    ballista) echo 'app.kubernetes.io/name=ballista,app.kubernetes.io/component=executor' ;;
  esac
}

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
