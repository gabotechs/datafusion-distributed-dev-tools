# Install the root-owned wrappers that sandbox untrusted Rust builds.
install --directory --owner root --group root --mode 0755 /usr/local/libexec/datafusion-pr-bot
install --owner root --group root --mode 0644 \
  ${release}/controller/cache-paths /usr/local/libexec/datafusion-pr-bot/cache-paths
install --owner root --group root --mode 0755 \
  ${release}/controller/prepare-cache /usr/local/sbin/datafusion-pr-prepare-cache
install --owner root --group root --mode 0755 \
  ${release}/controller/cargo-fetch /usr/local/sbin/datafusion-pr-cargo-fetch
install --owner root --group root --mode 0755 \
  ${release}/controller/cargo-build /usr/local/sbin/datafusion-pr-cargo-build
cat > /etc/sudoers.d/datafusion-pr-bot <<'SUDOERS'
benchmark-bot ALL=(root) NOPASSWD: /usr/local/sbin/datafusion-pr-prepare-cache, /usr/local/sbin/datafusion-pr-cargo-fetch, /usr/local/sbin/datafusion-pr-cargo-build
SUDOERS
chmod 0440 /etc/sudoers.d/datafusion-pr-bot
