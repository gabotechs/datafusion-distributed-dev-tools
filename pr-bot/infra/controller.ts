import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "./config.js";

export interface ControllerArguments {
  config: ControllerConfig;
  application: aws.s3.BucketObjectv2;
  artifactBucketName: pulumi.Output<string>;
  profile: aws.iam.InstanceProfile;
  identityDependencies: pulumi.Resource[];
}

function setupScript(...sections: string[]): string {
  return sections.join("\n\n");
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
  const userData = pulumi
    .all([args.application.key, args.artifactBucketName])
    .apply(([applicationKey, artifactBucketName]) =>
      setupScript(
        `#!/bin/bash
set -euo pipefail
`,
        // Install the operating-system packages used by the controller and builder.
        `dnf install --assumeyes \
  amazon-cloudwatch-agent clang cmake gcc gcc-c++ git jq make openssl-devel perl-core \
  pkgconf-pkg-config protobuf-compiler tar unzip xz
`,
        // Install the pinned Node.js runtime used by the controller application.
        `node_version=${config.nodeVersion}
node_archive=node-v\${node_version}-linux-x64.tar.xz
node_root=/opt/node-v\${node_version}-linux-x64
if [[ ! -x \${node_root}/bin/node ]]; then
  temporary=$(mktemp -d)
  curl --fail --silent --show-error --location https://nodejs.org/dist/v\${node_version}/\${node_archive} --output \${temporary}/\${node_archive}
  echo "${config.nodeSha256}  \${temporary}/\${node_archive}" | sha256sum --check --strict
  tar --extract --file \${temporary}/\${node_archive} --directory /opt --no-same-owner
  ln --symbolic --force \${node_root}/bin/node /usr/local/bin/node
  ln --symbolic --force \${node_root}/bin/npm /usr/local/bin/npm
  ln --symbolic --force \${node_root}/bin/npx /usr/local/bin/npx
fi
`,
        // Install pinned Kubernetes clients used by the trusted deployment harness.
        `kubectl_version=1.36.1
kubectl_sha256=629d3f410e09bf49b64ae7079f7f0bda1191efed311f7d37fdbab0ad5b0ec2b7
kubectl_temporary=$(mktemp -d)
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://dl.k8s.io/release/v\${kubectl_version}/bin/linux/amd64/kubectl \
  --output \${kubectl_temporary}/kubectl
echo "\${kubectl_sha256}  \${kubectl_temporary}/kubectl" | sha256sum --check --strict
install --owner root --group root --mode 0755 \${kubectl_temporary}/kubectl /usr/local/bin/kubectl

helm_version=4.2.3
helm_sha256=e9b88b4ee95b18c706839c28d3a0220e5bc470e9cd9262410c90793c45ff8b7c
helm_temporary=$(mktemp -d)
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://get.helm.sh/helm-v\${helm_version}-linux-amd64.tar.gz \
  --output \${helm_temporary}/helm.tar.gz
echo "\${helm_sha256}  \${helm_temporary}/helm.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file \${helm_temporary}/helm.tar.gz --directory \${helm_temporary} --no-same-owner
install --owner root --group root --mode 0755 \${helm_temporary}/linux-amd64/helm /usr/local/bin/helm
`,
        // Create the isolated controller/build identities and their state directories.
        `id benchmark-bot >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/datafusion-pr-bot benchmark-bot
id benchmark-build >/dev/null 2>&1 || useradd --create-home --home-dir /var/lib/datafusion-pr-build benchmark-build
getent group benchmark-cache >/dev/null 2>&1 || groupadd benchmark-cache
usermod --append --groups benchmark-cache benchmark-bot
usermod --append --groups benchmark-cache benchmark-build
install --directory --owner root --group root --mode 0755 /opt/datafusion-pr-bot /opt/datafusion-pr-bot/releases
install --directory --owner benchmark-bot --group benchmark-bot --mode 0700 /var/lib/datafusion-pr-bot
install --directory --owner benchmark-bot --group benchmark-cache --mode 2750 /var/lib/datafusion-pr-work /var/lib/datafusion-pr-work/jobs
install --directory --owner benchmark-build --group benchmark-cache --mode 2770 /var/cache/datafusion-pr-build /var/lib/datafusion-pr-build
`,
        // Download and install the immutable controller application release.
        `release=/opt/datafusion-pr-bot/releases/bootstrap
rm --recursive --force \${release}
install --directory --owner root --group root --mode 0755 \${release}
application_temporary=$(mktemp -d)
aws s3 cp s3://${artifactBucketName}/${applicationKey} \${application_temporary}/application.zip
unzip -q \${application_temporary}/application.zip -d \${release}
chown --recursive root:root \${release}
chmod --recursive go-w \${release}
ln --symbolic --force --no-dereference \${release} /opt/datafusion-pr-bot/current
`,
        // Install the root-owned wrappers that sandbox untrusted Rust builds.
        `install --directory --owner root --group root --mode 0755 /usr/local/libexec/datafusion-pr-bot
install --owner root --group root --mode 0644 \
  \${release}/controller/cache-paths /usr/local/libexec/datafusion-pr-bot/cache-paths
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
`,
        // Install the pinned Rust toolchain for the unprivileged build account.
        `rustup_version=1.28.2
rustup_sha256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
rustup_temporary=$(mktemp -d)
chmod 0755 \${rustup_temporary}
curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  https://static.rust-lang.org/rustup/archive/\${rustup_version}/x86_64-unknown-linux-gnu/rustup-init \
  --output \${rustup_temporary}/rustup-init
echo "\${rustup_sha256}  \${rustup_temporary}/rustup-init" | sha256sum --check --strict
chmod 0755 \${rustup_temporary}/rustup-init
sudo -u benchmark-build env HOME=/var/lib/datafusion-pr-build \
  \${rustup_temporary}/rustup-init -y --profile minimal --default-toolchain 1.91.0
`,
        // Install the pinned Zig toolchain and cargo-zigbuild.
        `zig_version=0.14.1
zig_sha256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c
zig_root=/opt/zig-x86_64-linux-\${zig_version}
if [[ ! -x \${zig_root}/zig ]]; then
  zig_temporary=$(mktemp -d)
  curl --fail --silent --show-error --location \
    https://ziglang.org/download/\${zig_version}/zig-x86_64-linux-\${zig_version}.tar.xz \
    --output \${zig_temporary}/zig.tar.xz
  echo "\${zig_sha256}  \${zig_temporary}/zig.tar.xz" | sha256sum --check --strict
  tar --extract --file \${zig_temporary}/zig.tar.xz --directory /opt --no-same-owner
fi
ln --symbolic --force \${zig_root}/zig /usr/local/bin/zig
sudo -u benchmark-build env HOME=/var/lib/datafusion-pr-build \
  /var/lib/datafusion-pr-build/.cargo/bin/cargo install \
  cargo-zigbuild --version 0.20.1 --locked
`,
        // Write the controller's protected runtime configuration.
        `cat > /var/lib/datafusion-pr-bot/controller.env <<'ENVIRONMENT'
AWS_REGION=${config.region}
GITHUB_REPOSITORY=${config.githubRepository}
SOURCE_REPOSITORY_URL=${config.sourceRepositoryUrl}
DATABASE_PATH=/var/lib/datafusion-pr-bot/jobs.db
STATE_ROOT=/var/lib/datafusion-pr-bot
BENCHMARK_WORK_ROOT=/var/lib/datafusion-pr-work
BUILD_CACHE_ROOT=/var/cache/datafusion-pr-build
BUILD_CACHE_MAX_GIB=400
KUBECONFIG=/var/lib/datafusion-pr-bot/kubeconfig
FOUNDATION_OUTPUTS_FILE=/var/lib/datafusion-pr-bot/foundation-outputs.json
BENCHMARK_HARNESS_ROOT=/opt/datafusion-pr-bot/current/benchmarks-remote
BENCHMARK_TESTDATA_ROOT=/var/lib/datafusion-pr-bot/testdata
ENVIRONMENT
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/controller.env
chmod 0600 /var/lib/datafusion-pr-bot/controller.env
`,
        // Configure access to the existing benchmark foundation.
        `sudo -u benchmark-bot aws eks update-kubeconfig --region ${config.region} --name ${config.clusterName} --alias ${config.clusterName} --kubeconfig /var/lib/datafusion-pr-bot/kubeconfig
cat > /var/lib/datafusion-pr-bot/foundation-outputs.json <<'OUTPUTS'
{"clusterName":"${config.clusterName}","datasetBucketName":"${config.datasetBucketName}","artifactBucketName":"${artifactBucketName}"}
OUTPUTS
chown benchmark-bot:benchmark-bot /var/lib/datafusion-pr-bot/foundation-outputs.json /var/lib/datafusion-pr-bot/kubeconfig
chmod 0600 /var/lib/datafusion-pr-bot/foundation-outputs.json /var/lib/datafusion-pr-bot/kubeconfig
`,
        // Define the long-running PR benchmark controller service.
        `cat > /etc/systemd/system/datafusion-pr-bot.service <<'SERVICE'
[Unit]
Description=DataFusion PR benchmark bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=benchmark-bot
Group=benchmark-bot
UMask=0077
WorkingDirectory=/opt/datafusion-pr-bot/current
Environment=HOME=/var/lib/datafusion-pr-bot
EnvironmentFile=/var/lib/datafusion-pr-bot/controller.env
ExecStart=/usr/local/bin/node /opt/datafusion-pr-bot/current/src/main.js
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
SERVICE
`,
        // Configure controller disk telemetry for the CloudWatch alarm.
        `cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json <<'CLOUDWATCH'
{
  "agent": {"metrics_collection_interval": 60},
  "metrics": {
    "namespace": "DataFusionPRBot",
    "append_dimensions": {"InstanceId": "\${aws:InstanceId}"},
    "aggregation_dimensions": [["InstanceId"]],
    "metrics_collected": {
      "disk": {
        "measurement": ["used_percent"],
        "metrics_collection_interval": 60,
        "resources": ["/"],
        "drop_device": true,
        "drop_original_metrics": ["used_percent"]
      }
    }
  }
}
CLOUDWATCH
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s
`,
        // Start the controller after every setup section has completed.
        `systemctl daemon-reload
systemctl enable --now datafusion-pr-bot.service
`,
      ),
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
  const diskAlarm = new aws.cloudwatch.MetricAlarm("bot-controller-disk", {
    namespace: "DataFusionPRBot",
    metricName: "disk_used_percent",
    dimensions: { InstanceId: controller.id },
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    evaluationPeriods: 2,
    period: 300,
    statistic: "Maximum",
    threshold: 85,
    treatMissingData: "breaching",
    alarmDescription:
      "PR benchmark controller root disk is above 85% or not reporting",
  });
  return { controller, publicAddress, diskAlarm };
}
