# Install pinned Kubernetes clients used by the trusted deployment harness.
kubectl_version={{KUBECTL_VERSION}}
kubectl_sha256={{KUBECTL_SHA256}}
kubectl_temporary=$(mktemp -d)
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://dl.k8s.io/release/v${kubectl_version}/bin/linux/amd64/kubectl \
  --output ${kubectl_temporary}/kubectl
echo "${kubectl_sha256}  ${kubectl_temporary}/kubectl" | sha256sum --check --strict
install --owner root --group root --mode 0755 ${kubectl_temporary}/kubectl /usr/local/bin/kubectl

helm_version={{HELM_VERSION}}
helm_sha256={{HELM_SHA256}}
helm_temporary=$(mktemp -d)
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://get.helm.sh/helm-v${helm_version}-linux-amd64.tar.gz \
  --output ${helm_temporary}/helm.tar.gz
echo "${helm_sha256}  ${helm_temporary}/helm.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file ${helm_temporary}/helm.tar.gz --directory ${helm_temporary} --no-same-owner
install --owner root --group root --mode 0755 ${helm_temporary}/linux-amd64/helm /usr/local/bin/helm
