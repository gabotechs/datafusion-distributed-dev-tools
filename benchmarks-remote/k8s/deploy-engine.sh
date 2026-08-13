#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_dir}/lib.sh"

engine=${1:?usage: deploy-engine.sh ENGINE}
validate_engine "${engine}"
init_environment
deployment_name=${DEPLOYMENT_NAME:-${engine}}
validate_deployment_name "${deployment_name}"

dataset_bucket=$(jq -er '.datasetBucketName' "${outputs_file}")
node_count=${NODE_COUNT:-$(jq -er '.benchmarkNodeCount' "${outputs_file}")}
require_aws_credentials
ensure_kubeconfig

manifest_values=()
case ${engine} in
  datafusion)
    benchmark_instance_type=${BENCHMARK_INSTANCE_TYPE:-$(jq -er '.benchmarkInstanceType' "${outputs_file}")}
    worker_artifact=${WORKER_ARTIFACT:-$(bash "${root}/benchmarks-remote/k8s/publish-datafusion.sh")}
    : "${worker_artifact:?DataFusion worker publishing did not produce an artifact}"
    manifest_values+=(--set-string worker.artifact="${worker_artifact}")
    manifest_values+=(--set-string worker.datasetBucket="${dataset_bucket}")
    manifest_values+=(--set-string worker.replicas="${node_count}")
    manifest_values+=(--set-string worker.instanceType="${benchmark_instance_type}")
    manifest_values+=(--set-string name="${deployment_name}")
    ;;
  trino)
    benchmark_instance_type=$(jq -er '.benchmarkInstanceType' "${outputs_file}")
    coordinator_instance_type=$(jq -er '.coordinatorInstanceType' "${outputs_file}")
    manifest_values+=(--set-string region="${region}")
    manifest_values+=(--set-string datasetBucket="${dataset_bucket}")
    manifest_values+=(--set-string workerReplicas="${node_count}")
    manifest_values+=(--set-string workerInstanceType="${benchmark_instance_type}")
    manifest_values+=(--set-string coordinatorInstanceType="${coordinator_instance_type}")
    ;;
  spark)
    benchmark_instance_type=$(jq -er '.benchmarkInstanceType' "${outputs_file}")
    coordinator_instance_type=$(jq -er '.coordinatorInstanceType' "${outputs_file}")
    spark_image=${SPARK_IMAGE:-$(bash "${root}/benchmarks-remote/k8s/publish-image.sh" spark)}
    : "${spark_image:?Spark publishing did not produce an image}"
    manifest_values+=(--set-string image="${spark_image}")
    manifest_values+=(--set-string workerReplicas="${node_count}")
    manifest_values+=(--set-string workerInstanceType="${benchmark_instance_type}")
    manifest_values+=(--set-string coordinatorInstanceType="${coordinator_instance_type}")
    ;;
  ballista)
    benchmark_instance_type=$(jq -er '.benchmarkInstanceType' "${outputs_file}")
    coordinator_instance_type=$(jq -er '.coordinatorInstanceType' "${outputs_file}")
    ballista_artifacts=$(bash "${root}/benchmarks-remote/k8s/publish-ballista.sh")
    scheduler_artifact=$(jq -er '.["ballista-scheduler"]' <<<"${ballista_artifacts}")
    executor_artifact=$(jq -er '.["ballista-executor"]' <<<"${ballista_artifacts}")
    http_artifact=$(jq -er '.["ballista-http"]' <<<"${ballista_artifacts}")
    : "${scheduler_artifact:?Ballista publishing did not produce the scheduler artifact}"
    : "${executor_artifact:?Ballista publishing did not produce the executor artifact}"
    : "${http_artifact:?Ballista publishing did not produce the HTTP artifact}"
    manifest_values+=(--set-string datasetBucket="${dataset_bucket}")
    manifest_values+=(--set-string artifacts.scheduler="${scheduler_artifact}")
    manifest_values+=(--set-string artifacts.executor="${executor_artifact}")
    manifest_values+=(--set-string artifacts.http="${http_artifact}")
    manifest_values+=(--set-string workerReplicas="${node_count}")
    manifest_values+=(--set-string workerInstanceType="${benchmark_instance_type}")
    manifest_values+=(--set-string coordinatorInstanceType="${coordinator_instance_type}")
    ;;
esac

HELM_CACHE_HOME=/tmp/datafusion-distributed-helm-cache \
  HELM_CONFIG_HOME=/tmp/datafusion-distributed-helm-config \
  HELM_DATA_HOME=/tmp/datafusion-distributed-helm-data \
  helm upgrade --install "${deployment_name}" "${root}/benchmarks-remote/k8s/${engine}" \
  --namespace "benchmark-${engine}" \
  --kube-context "${cluster_name}" \
  --values "${root}/benchmarks-remote/k8s/worker-resources.yaml" \
  --rollback-on-failure \
  --cleanup-on-fail \
  --wait \
  --timeout 25m \
  "${manifest_values[@]}"

echo "Deployed ${deployment_name}; it will remain running until npm run ${engine}-destroy"
