# Install the pinned Rust toolchain for the unprivileged build account.
rustup_version={{RUSTUP_VERSION}}
rustup_sha256={{RUSTUP_SHA256}}
rustup_temporary=$(mktemp -d)
chmod 0755 ${rustup_temporary}
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  https://static.rust-lang.org/rustup/archive/${rustup_version}/x86_64-unknown-linux-gnu/rustup-init \
  --output ${rustup_temporary}/rustup-init
echo "${rustup_sha256}  ${rustup_temporary}/rustup-init" | sha256sum --check --strict
chmod 0755 ${rustup_temporary}/rustup-init
sudo -u benchmark-build env HOME=/var/lib/datafusion-pr-build \
  ${rustup_temporary}/rustup-init -y --profile minimal --default-toolchain {{RUST_TOOLCHAIN}}
