#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pulumi_bin=${PULUMI_BIN:-pulumi}
stack=${PULUMI_STACK:-benchmark}
cd "${script_dir}"
export AWS_REGION=${AWS_REGION:-us-east-1}
secrets_provider=${PULUMI_SECRETS_PROVIDER:-awskms://alias/datafusion-bench-pulumi-state?region=${AWS_REGION}}
if ! AWS_PAGER='' aws --region "${AWS_REGION}" sts get-caller-identity >/dev/null; then
  echo "AWS credentials are missing or expired; select AWS_PROFILE and run aws sso login" >&2
  exit 1
fi
if [[ -n ${PULUMI_BACKEND_URL:-} ]]; then
  "${pulumi_bin}" login "${PULUMI_BACKEND_URL}"
fi
"${pulumi_bin}" stack select "${stack}" --create --secrets-provider "${secrets_provider}"
if [[ -z ${KUBERNETES_API_ALLOWED_CIDRS:-} ]]; then
  public_ip=$(curl --fail --silent --show-error https://checkip.amazonaws.com)
  configured_cidrs=$("${pulumi_bin}" config get kubernetesApiAllowedCidrs --json 2>/dev/null || echo '[]')
  # Keep CIDRs that earlier deploys added for other callers' public IPs.
  cluster_name=$("${pulumi_bin}" stack output clusterName --stack "${stack}" 2>/dev/null || true)
  live_cidrs='[]'
  if [[ -n ${cluster_name} ]]; then
    live_cidrs=$(AWS_PAGER='' aws --region "${AWS_REGION}" eks describe-cluster \
      --name "${cluster_name}" \
      --query 'cluster.resourcesVpcConfig.publicAccessCidrs' \
      --output json 2>/dev/null || echo '[]')
  fi
  export KUBERNETES_API_ALLOWED_CIDRS
  KUBERNETES_API_ALLOWED_CIDRS=$(jq -r \
    --arg current "${public_ip}/32" \
    --argjson live "${live_cidrs}" \
    '
      if type == "array" then .
      elif type == "object" and (.value | type) == "array" then .value
      elif type == "object" and (.value | type) == "string" then (.value | fromjson)
      elif type == "string" then fromjson
      else []
      end
      | . + ($live // []) + [$current]
      | map(select(. != "0.0.0.0/0")) | unique | join(",")
    ' <<<"${configured_cidrs}")
fi
"${pulumi_bin}" up --stack "${stack}" --yes
if [[ ${stack} == benchmark ]]; then
  outputs_file=${PULUMI_OUTPUTS_FILE:-${script_dir}/.pulumi-outputs.json}
  kubeconfig=${KUBECONFIG:-${script_dir}/../k8s/.kubeconfig}
else
  outputs_file=${PULUMI_OUTPUTS_FILE:-${script_dir}/.pulumi-outputs.${stack}.json}
  kubeconfig=${KUBECONFIG:-${script_dir}/../k8s/.kubeconfig.${stack}}
fi
outputs_tmp=$(mktemp "${outputs_file}.XXXXXX")
trap 'rm -f "${outputs_tmp}"' EXIT INT TERM HUP
"${pulumi_bin}" stack output --stack "${stack}" --json >"${outputs_tmp}"
mv "${outputs_tmp}" "${outputs_file}"
trap - EXIT INT TERM HUP
PULUMI_OUTPUTS_FILE="${outputs_file}" KUBECONFIG="${kubeconfig}" \
  REFRESH_KUBECONFIG=true "${script_dir}/../k8s/install-tenancy.sh"
