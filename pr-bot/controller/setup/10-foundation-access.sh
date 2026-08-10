# Configure access to the existing benchmark foundation.
sudo -u benchmark-bot aws eks update-kubeconfig --region {{AWS_REGION}} --name {{EKS_CLUSTER_NAME}} --alias {{EKS_CLUSTER_NAME}} --kubeconfig /var/lib/datafusion-pr-bot/kubeconfig
cat > /var/lib/datafusion-pr-bot/foundation-outputs.json <<'OUTPUTS'
{"clusterName":"{{EKS_CLUSTER_NAME}}","datasetBucketName":"{{DATASET_BUCKET_NAME}}","artifactBucketName":"{{ARTIFACT_BUCKET_NAME}}"}
OUTPUTS
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/foundation-outputs.json /var/lib/datafusion-pr-bot/kubeconfig
chmod 0600 /var/lib/datafusion-pr-bot/foundation-outputs.json /var/lib/datafusion-pr-bot/kubeconfig
