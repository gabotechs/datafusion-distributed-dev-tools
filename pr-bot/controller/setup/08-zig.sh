# Install the pinned Zig toolchain and cargo-zigbuild.
zig_version={{ZIG_VERSION}}
zig_sha256={{ZIG_SHA256}}
zig_root=/opt/zig-x86_64-linux-${zig_version}
if [[ ! -x ${zig_root}/zig ]]; then
  zig_temporary=$(mktemp -d)
  curl --fail --silent --show-error --location \
    https://ziglang.org/download/${zig_version}/zig-x86_64-linux-${zig_version}.tar.xz \
    --output ${zig_temporary}/zig.tar.xz
  echo "${zig_sha256}  ${zig_temporary}/zig.tar.xz" | sha256sum --check --strict
  tar --extract --file ${zig_temporary}/zig.tar.xz --directory /opt --no-same-owner
fi
ln --symbolic --force ${zig_root}/zig /usr/local/bin/zig
sudo -u benchmark-build env HOME=/var/lib/datafusion-pr-build \
  /var/lib/datafusion-pr-build/.cargo/bin/cargo install \
  cargo-zigbuild --version {{CARGO_ZIGBUILD_VERSION}} --locked
