import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "./config.js";

export interface ControllerArguments {
  config: ControllerConfig;
  application: aws.s3.BucketObjectv2;
  githubSecret: aws.secretsmanager.Secret;
  githubSecretVersion: aws.secretsmanager.SecretVersion;
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
  const userData = pulumi
    .all([args.application.key, args.githubSecret.arn])
    .apply(
      ([applicationKey, secretArn]) => `#!/bin/bash
set -euo pipefail

dnf install --assumeyes curl git jq podman tar xz

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
install --directory --owner benchmark-bot --group benchmark-bot /opt/datafusion-pr-bot/releases /var/lib/datafusion-pr-bot /var/lib/datafusion-pr-bot/run
release=/opt/datafusion-pr-bot/releases/bootstrap
rm --recursive --force \${release}
install --directory --owner benchmark-bot --group benchmark-bot \${release}
aws s3 cp s3://${config.datasetBucketName}/${applicationKey} /tmp/datafusion-pr-bot.tar.gz
tar --extract --gzip --file /tmp/datafusion-pr-bot.tar.gz --directory \${release}
chown --recursive benchmark-bot:benchmark-bot \${release}
ln --symbolic --force --no-dereference \${release} /opt/datafusion-pr-bot/current

sudo -u benchmark-bot env HOME=/var/lib/datafusion-pr-bot npm --prefix \${release} ci
sudo -u benchmark-bot env HOME=/var/lib/datafusion-pr-bot XDG_RUNTIME_DIR=/var/lib/datafusion-pr-bot/run podman build --tag localhost/datafusion-pr-benchmark-builder:latest \${release}/builder

secret=$(aws secretsmanager get-secret-value --secret-id ${secretArn} --query SecretString --output text)
jq --raw-output 'to_entries[] | "\(.key)=\(.value|@json)"' <<<"\${secret}" > /var/lib/datafusion-pr-bot/controller.env
cat >> /var/lib/datafusion-pr-bot/controller.env <<'ENVIRONMENT'
AWS_REGION=${config.region}
BUILDER_IMAGE=localhost/datafusion-pr-benchmark-builder:latest
CONTAINER_RUNTIME=podman
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
Environment=XDG_RUNTIME_DIR=/var/lib/datafusion-pr-bot/run
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
      dependsOn: [
        args.application,
        args.githubSecretVersion,
        ...args.identityDependencies,
      ],
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
