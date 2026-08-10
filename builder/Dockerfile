FROM rust:1.91.0-bookworm

ARG ZIG_VERSION=0.14.1
ARG CARGO_ZIGBUILD_VERSION=0.20.1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl xz-utils ca-certificates \
    && curl --fail --silent --show-error --location \
      "https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz" \
      --output /tmp/zig.tar.xz \
    && tar --extract --file /tmp/zig.tar.xz --directory /opt \
    && ln --symbolic "/opt/zig-x86_64-linux-${ZIG_VERSION}/zig" /usr/local/bin/zig \
    && cargo install cargo-zigbuild --version "${CARGO_ZIGBUILD_VERSION}" --locked \
    && rustup target add x86_64-unknown-linux-gnu \
    && rm --recursive --force /var/lib/apt/lists/* /tmp/zig.tar.xz

WORKDIR /source
