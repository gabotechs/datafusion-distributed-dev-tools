#!/usr/bin/env bash
set -euo pipefail

result_dir=${1:?usage: sum-tasks.sh RESULT_DIRECTORY}

if [[ ! -d ${result_dir} ]]; then
  echo "Result directory does not exist: ${result_dir}" >&2
  exit 1
fi

shopt -s nullglob
result_files=("${result_dir}"/q*.json)
if (( ${#result_files[@]} == 0 )); then
  echo "No q*.json result files found in ${result_dir}" >&2
  exit 1
fi

jq -s '
  [.[].iterations[] | select(.error == null) | .tasks] | add // 0
' "${result_files[@]}"
