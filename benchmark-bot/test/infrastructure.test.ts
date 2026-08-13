import assert from "node:assert/strict";
import test, { before } from "node:test";

import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "../infra/config.js";
import { createControllerInfrastructure } from "../infra/foundation.js";
import { controllerToolVersions } from "../infra/versions.js";

interface RegisteredResource {
  type: string;
  name: string;
  inputs: Record<string, unknown>;
}

const resources: RegisteredResource[] = [];

function testConfig(): ControllerConfig {
  return {
    namePrefix: "df-pr-test",
    region: "us-east-1",
    controllerSubnetId: "subnet-public123",
    controllerInstanceType: "c7i.4xlarge",
    controllerVolumeSizeGiB: 500,
    clusterName: "human-managed-benchmark-cluster",
    datasetBucketName: "human-managed-datasets",
    benchmarkWorkloadRoleArn:
      "arn:aws:iam::123456789012:role/benchmark-workload-role",
    githubRepository: "owner/repository",
    authorizedGithubLogins: ["maintainer"],
    sourceRepositoryUrl: "https://example.invalid/repository.git",
    nodeVersion: "24.18.1",
    nodeSha256:
      "d6c664df3f3f61458e8c277585571328522d705166723a7c7823a9253a4d15a0",
  };
}

before(async () => {
  await pulumi.runtime.setMocks(
    {
      newResource(args): { id: string; state: Record<string, unknown> } {
        resources.push({
          type: args.type,
          name: args.name,
          inputs: args.inputs,
        });
        const state = { ...args.inputs };
        if (args.type === "aws:iam/role:Role") {
          state.name = args.name;
          state.arn = `arn:aws:iam::123456789012:role/${args.name}`;
        } else if (args.type === "aws:ec2/eip:Eip") {
          state.publicIp = "192.0.2.20";
        } else if (args.type === "aws:s3/bucket:Bucket") {
          state.arn = `arn:aws:s3:::${args.name}`;
        } else if (args.type === "aws:s3/bucketObjectv2:BucketObjectv2") {
          state.versionId = "version-123";
        }
        return { id: `${args.name}_id`, state };
      },
      call(args): Record<string, unknown> {
        if (args.token === "aws:eks/getCluster:getCluster") {
          return {
            ...args.inputs,
            arn: `arn:aws:eks:us-east-1:123456789012:cluster/${args.inputs.name}`,
          };
        }
        if (args.token === "aws:ec2/getSubnet:getSubnet") {
          return { ...args.inputs, vpcId: "vpc-default123" };
        }
        if (args.token === "aws:ssm/getParameter:getParameter") {
          return { ...args.inputs, value: "ami-12345678" };
        }
        return args.inputs;
      },
    },
    "datafusion-pr-bot",
    "test",
    false,
  );
  await pulumi.runtime.runInPulumiStack(async () =>
    createControllerInfrastructure(testConfig()),
  );
});

function resource(type: string, name?: string): RegisteredResource {
  const result = resources.find(
    (candidate) =>
      candidate.type === type &&
      (name === undefined || candidate.name === name),
  );
  assert.ok(result, `missing ${type} ${name ?? ""}`);
  return result;
}

test("does not create or mutate the human-managed EKS foundation", () => {
  assert.equal(
    resources.filter((candidate) => candidate.type.startsWith("aws:eks/"))
      .length,
    0,
  );
  assert.equal(
    resources.filter(
      (candidate) =>
        candidate.type === "aws:ec2/vpc:Vpc" ||
        candidate.type === "aws:ec2/subnet:Subnet" ||
        candidate.type === "aws:ec2/natGateway:NatGateway",
    ).length,
    0,
  );
});

test("creates only a passive controller with stable outbound identity", () => {
  const instance = resource("aws:ec2/instance:Instance", "bot-controller");
  assert.equal(instance.inputs.subnetId, "subnet-public123");
  assert.equal(instance.inputs.associatePublicIpAddress, true);
  assert.deepEqual(instance.inputs.metadataOptions, {
    httpEndpoint: "enabled",
    httpPutResponseHopLimit: 1,
    httpTokens: "required",
  });
  assert.deepEqual(instance.inputs.rootBlockDevice, {
    deleteOnTermination: true,
    encrypted: true,
    volumeSize: 500,
    volumeType: "gp3",
  });
  const securityGroup = resource(
    "aws:ec2/securityGroup:SecurityGroup",
    "bot-controller-security",
  );
  assert.deepEqual(securityGroup.inputs.ingress, []);
  resource("aws:ec2/eip:Eip", "bot-controller-address");
  resource(
    "aws:ec2/eipAssociation:EipAssociation",
    "bot-controller-address-association",
  );
});

test("deploys every controller archive through Systems Manager", () => {
  const deployment = resource(
    "aws:ssm/association:Association",
    "bot-controller-deployment",
  );
  assert.equal(deployment.inputs.name, "AWS-RunShellScript");
  assert.equal(deployment.inputs.waitForSuccessTimeoutSeconds, 3600);
  assert.deepEqual(deployment.inputs.targets, [
    { key: "InstanceIds", values: ["bot-controller_id"] },
  ]);
  const commands = String(
    (deployment.inputs.parameters as Record<string, unknown>).commands,
  );
  assert.match(commands, /s3api get-object/);
  assert.match(commands, /--version-id 'version-123'/);
  assert.match(commands, /controller\/install-release/);
  assert.match(commands, /https:\/\/example\.invalid\/repository\.git/);
  assert.match(commands, /systemctl is-active --quiet datafusion-pr-bot/);
});

test("leaves GH_TOKEN provisioning outside Pulumi", () => {
  assert.equal(
    resources.filter((candidate) =>
      candidate.type.startsWith("aws:secretsmanager/"),
    ).length,
    0,
  );
  const policy = resource(
    "aws:iam/rolePolicy:RolePolicy",
    "bot-controller-policy",
  );
  assert.doesNotMatch(String(policy.inputs.policy), /secretsmanager/);
});

test("limits AWS permissions to the configured foundation", () => {
  const policy = resource(
    "aws:iam/rolePolicy:RolePolicy",
    "bot-controller-policy",
  );
  const document = String(policy.inputs.policy);
  assert.match(document, /human-managed-datasets/);
  assert.match(document, /human-managed-benchmark-cluster/);
  assert.doesNotMatch(document, /eks:CreateCluster/);
  assert.doesNotMatch(document, /ec2:RunInstances/);
  assert.match(document, /bot-artifacts\/controller\/\*/);
  assert.match(document, /bot-artifacts\/workers\/\*/);
  assert.doesNotMatch(document, /bot-artifacts\/\*"/);
  assert.match(document, /cloudwatch:PutMetricData/);
  assert.match(document, /DataFusionPRBot/);
});

test("separates private bot artifacts from the dataset bucket", () => {
  resource("aws:s3/bucket:Bucket", "bot-artifacts");
  const publicAccess = resource(
    "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock",
    "bot-artifacts-public-access",
  );
  assert.equal(publicAccess.inputs.blockPublicAcls, true);
  assert.equal(publicAccess.inputs.blockPublicPolicy, true);
  resource(
    "aws:s3/bucketVersioning:BucketVersioning",
    "bot-artifacts-versioning",
  );
  const application = resource(
    "aws:s3/bucketObjectv2:BucketObjectv2",
    "bot-controller-application",
  );
  assert.equal(application.inputs.key, "controller/application.zip");
  assert.notEqual(application.inputs.bucket, "human-managed-datasets");
  const bucketPolicy = resource(
    "aws:s3/bucketPolicy:BucketPolicy",
    "bot-artifacts-policy",
  );
  const policy = String(bucketPolicy.inputs.policy);
  assert.match(policy, /benchmark-workload-role/);
  assert.match(policy, /workers\/\*/);
  assert.doesNotMatch(policy, /controller\/\*/);
});

test("installs protected controller state and verified native toolchains", () => {
  const instance = resource("aws:ec2/instance:Instance", "bot-controller");
  const userData = String(instance.inputs.userData);
  assert.match(userData, /--mode 0700 \/var\/lib\/datafusion-pr-bot/);
  assert.match(userData, /\/var\/cache\/datafusion-pr-build/);
  assert.match(userData, /sha256sum --check --strict/);
  assert.match(
    userData,
    /rustup_temporary=\$\(mktemp -d\)\nchmod 0755 \$\{rustup_temporary\}/,
  );
  assert.match(userData, /rustup-init -y --profile minimal/);
  assert.ok(
    userData.includes(`--default-toolchain ${controllerToolVersions.rust}`),
  );
  assert.ok(
    userData.includes(
      `kubectl_version=${controllerToolVersions.kubectl.version}`,
    ),
  );
  assert.ok(
    userData.includes(`helm_version=${controllerToolVersions.helm.version}`),
  );
  assert.match(userData, /install .*\/usr\/local\/bin\/kubectl/);
  assert.match(userData, /install .*\/usr\/local\/bin\/helm/);
  assert.match(userData, /controller\/install-release/);
  assert.match(
    userData,
    /DATAFUSION_SOURCE_ROOT=\/opt\/datafusion-pr-bot\/datafusion-distributed/,
  );
  assert.match(
    userData,
    /ExecStart=\/usr\/local\/bin\/node \/opt\/datafusion-pr-bot\/current\/src\/main\.js/,
  );
  assert.doesNotMatch(userData, /npm --prefix .* ci/);
  assert.match(userData, /amazon-cloudwatch-agent/);
  assert.match(
    userData,
    /aws s3 cp s3:\/\/bot-artifacts_id\/controller\/application\.zip/,
  );
  assert.match(userData, /"artifactBucketName":"bot-artifacts_id"/);
  assert.doesNotMatch(userData, /benchmarkInstanceType|benchmarkNodeCount/);
  assert.doesNotMatch(
    userData,
    /\$\{artifactBucketName\}|\$\{applicationKey\}/,
  );
  assert.doesNotMatch(userData, /\{\{[A-Z0-9_]+\}\}/);
  const diskAlarm = resource(
    "aws:cloudwatch/metricAlarm:MetricAlarm",
    "bot-controller-disk",
  );
  assert.equal(diskAlarm.inputs.threshold, 85);
  assert.equal(diskAlarm.inputs.treatMissingData, "breaching");
});
