import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "./config.js";

export interface ControllerArguments {
  config: ControllerConfig;
  application: aws.s3.BucketObjectv2;
  profile: aws.iam.InstanceProfile;
  identityDependencies: pulumi.Resource[];
}

export function createController(args: ControllerArguments) {
  const { config } = args;
  let subnetId: pulumi.Output<string>;
  if (config.controllerSubnetId) {
    subnetId = pulumi.output(config.controllerSubnetId);
  } else {
    const defaultVpc = aws.ec2.getVpcOutput({ default: true });
    const defaultSubnets = aws.ec2.getSubnetsOutput({
      filters: [{ name: "vpc-id", values: [defaultVpc.id] }],
    });
    subnetId = defaultSubnets.ids.apply((subnets) => {
      if (!subnets[0]) {
        throw new Error(
          "The default VPC has no subnet; configure controllerSubnetId",
        );
      }
      return subnets[0];
    });
  }
  const subnet = aws.ec2.getSubnetOutput({ id: subnetId });
  const securityGroup = new aws.ec2.SecurityGroup("bot-controller-security", {
    vpcId: subnet.vpcId,
    description: "No inbound access; controller administration uses SSM",
    ingress: [],
    egress: [
      {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
      },
    ],
    tags: { Name: `${config.namePrefix}-controller` },
  });
  const ami = aws.ssm.getParameterOutput({
    name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
  });
  const userData = args.application.key.apply(
    (applicationKey) => `#!/bin/bash
set -euo pipefail

dnf install --assumeyes \
  clang cmake curl gcc gcc-c++ git jq make openssl-devel perl-core \
  pkgconf-pkg-config protobuf-compiler tar xz

node_version=${config.nodeVersion}
node_archive=node-v\${node_version}-linux-x64.tar.xz
node_root=/opt/node-v\${node_version}-linux-x64
if [[ ! -x \${node_root}/bin/node ]]; then
  temporary=$(mktemp -d)
  curl --fail --silent --show-error --location https://nodejs.org/dist/v\${node_version}/\${node_archive} --output \${temporary}/\${node_archive}
  curl --fail --silent --show-error --location https://nodejs.org/dist/v\${node_version}/SHASUMS256.txt --output \${temporary}/SHASUMS256.txt
  cd \${temporary}
  grep "  \${node_archive}$" SHASUMS256.txt | sha256sum --check --strict
  tar --extract --file \${node_archive} --directory /opt
  ln --symbolic --force \${node_root}/bin/node /usr/local/bin/node
  ln --symbolic --force \${node_root}/bin/npm /usr/local/bin/npm
  ln --symbolic --force \${node_root}/bin/npx /usr/local/bin/npx
fi

id benchmark-bot >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/datafusion-pr-bot benchmark-bot
id benchmark-build >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/datafusion-pr-build benchmark-build
install --directory --owner benchmark-bot --group benchmark-bot /opt/datafusion-pr-bot/releases /var/lib/datafusion-pr-bot
install --directory --owner benchmark-build --group benchmark-build /var/lib/datafusion-pr-bot/build-cache /var/lib/datafusion-pr-build
release=/opt/datafusion-pr-bot/releases/bootstrap
rm --recursive --force \${release}
install --directory --owner benchmark-bot --group benchmark-bot \${release}
aws s3 cp s3://${config.datasetBucketName}/${applicationKey} /tmp/datafusion-pr-bot.tar.gz
tar --extract --gzip --file /tmp/datafusion-pr-bot.tar.gz --directory \${release}
chown --recursive benchmark-bot:benchmark-bot \${release}
ln --symbolic --force --no-dereference \${release} /opt/datafusion-pr-bot/current

sudo -u benchmark-bot env HOME=/var/lib/datafusion-pr-bot npm --prefix \${release} ci

install --owner root --group root --mode 0755 \
  \${release}/controller/prepare-cache /usr/local/sbin/datafusion-pr-prepare-cache
install --owner root --group root --mode 0755 \
  \${release}/controller/cargo-fetch /usr/local/sbin/datafusion-pr-cargo-fetch
install --owner root --group root --mode 0755 \
  \${release}/controller/cargo-build /usr/local/sbin/datafusion-pr-cargo-build
cat > /etc/sudoers.d/datafusion-pr-bot <<'SUDOERS'
benchmark-bot ALL=(root) NOPASSWD: /usr/local/sbin/datafusion-pr-prepare-cache, /usr/local/sbin/datafusion-pr-cargo-fetch, /usr/local/sbin/datafusion-pr-cargo-build
SUDOERS
chmod 0440 /etc/sudoers.d/datafusion-pr-bot

curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://sh.rustup.rs --output /tmp/rustup-init.sh
chmod 0755 /tmp/rustup-init.sh
sudo -u benchmark-build env HOME=/var/lib/datafusion-pr-build \
  /tmp/rustup-init.sh --yes --profile minimal --default-toolchain 1.91.0

zig_version=0.14.1
zig_root=/opt/zig-x86_64-linux-\${zig_version}
if [[ ! -x \${zig_root}/zig ]]; then
  curl --fail --silent --show-error --location \
    https://ziglang.org/download/\${zig_version}/zig-x86_64-linux-\${zig_version}.tar.xz \
    --output /tmp/zig.tar.xz
  tar --extract --file /tmp/zig.tar.xz --directory /opt
fi
ln --symbolic --force \${zig_root}/zig /usr/local/bin/zig
sudo -u benchmark-build env HOME=/var/lib/datafusion-pr-build \
  /var/lib/datafusion-pr-build/.cargo/bin/cargo install \
  cargo-zigbuild --version 0.20.1 --locked

cat > /var/lib/datafusion-pr-bot/controller.env <<'ENVIRONMENT'
AWS_REGION=${config.region}
GITHUB_REPOSITORY=${config.githubRepository}
SOURCE_REPOSITORY_URL=${config.sourceRepositoryUrl}
DATABASE_PATH=/var/lib/datafusion-pr-bot/jobs.db
STATE_ROOT=/var/lib/datafusion-pr-bot
KUBECONFIG=/var/lib/datafusion-pr-bot/kubeconfig
FOUNDATION_OUTPUTS_FILE=/var/lib/datafusion-pr-bot/foundation-outputs.json
BENCHMARK_TESTDATA_ROOT=/var/lib/datafusion-pr-bot/testdata
ENVIRONMENT
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/controller.env
chmod 0600 /var/lib/datafusion-pr-bot/controller.env

sudo -u benchmark-bot aws eks update-kubeconfig --region ${config.region} --name ${config.clusterName} --alias ${config.clusterName} --kubeconfig /var/lib/datafusion-pr-bot/kubeconfig
cat > /var/lib/datafusion-pr-bot/foundation-outputs.json <<'OUTPUTS'
{"clusterName":"${config.clusterName}","datasetBucketName":"${config.datasetBucketName}","artifactBucketName":"${config.datasetBucketName}","benchmarkInstanceType":"${config.benchmarkInstanceType}","benchmarkNodeCount":${config.benchmarkNodeCount}}
OUTPUTS
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/foundation-outputs.json /var/lib/datafusion-pr-bot/kubeconfig

cat > /etc/systemd/system/datafusion-pr-bot.service <<'SERVICE'
[Unit]
Description=DataFusion PR benchmark bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=benchmark-bot
Group=benchmark-bot
WorkingDirectory=/opt/datafusion-pr-bot/current
Environment=HOME=/var/lib/datafusion-pr-bot
EnvironmentFile=/var/lib/datafusion-pr-bot/controller.env
ExecStart=/usr/local/bin/npm start
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now datafusion-pr-bot.service
`,
  );
  const controller = new aws.ec2.Instance(
    "bot-controller",
    {
      ami: ami.value,
      instanceType: config.controllerInstanceType,
      subnetId,
      vpcSecurityGroupIds: [securityGroup.id],
      associatePublicIpAddress: true,
      iamInstanceProfile: args.profile.name,
      userData,
      userDataReplaceOnChange: false,
      metadataOptions: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 1,
      },
      rootBlockDevice: {
        volumeType: "gp3",
        volumeSize: config.controllerVolumeSizeGiB,
        encrypted: true,
        deleteOnTermination: true,
      },
      tags: { Name: `${config.namePrefix}-controller` },
    },
    {
      dependsOn: [args.application, ...args.identityDependencies],
    },
  );
  const publicAddress = new aws.ec2.Eip("bot-controller-address", {
    domain: "vpc",
    tags: { Name: `${config.namePrefix}-controller` },
  });
  new aws.ec2.EipAssociation("bot-controller-address-association", {
    allocationId: publicAddress.id,
    instanceId: controller.id,
  });
  return { controller, publicAddress };
}
