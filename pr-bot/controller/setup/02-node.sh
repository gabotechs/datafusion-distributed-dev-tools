# Install the pinned Node.js runtime used by the controller application.
node_version={{NODE_VERSION}}
node_archive=node-v${node_version}-linux-x64.tar.xz
node_root=/opt/node-v${node_version}-linux-x64
if [[ ! -x ${node_root}/bin/node ]]; then
  temporary=$(mktemp -d)
  curl --fail --silent --show-error --location https://nodejs.org/dist/v${node_version}/${node_archive} --output ${temporary}/${node_archive}
  echo "{{NODE_SHA256}}  ${temporary}/${node_archive}" | sha256sum --check --strict
  tar --extract --file ${temporary}/${node_archive} --directory /opt --no-same-owner
  ln --symbolic --force ${node_root}/bin/node /usr/local/bin/node
  ln --symbolic --force ${node_root}/bin/npm /usr/local/bin/npm
  ln --symbolic --force ${node_root}/bin/npx /usr/local/bin/npx
fi
