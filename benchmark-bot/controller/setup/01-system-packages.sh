# Install the operating-system packages used by the controller and builder.
dnf install --assumeyes \
  amazon-cloudwatch-agent clang cmake gcc gcc-c++ git jq make openssl-devel perl-core \
  pkgconf-pkg-config protobuf-compiler tar unzip xz
