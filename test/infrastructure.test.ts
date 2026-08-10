import assert from "node:assert/strict";
import test, { before } from "node:test";

import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "../infra/config.js";
import { createControllerInfrastructure } from "../infra/foundation.js";

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
    benchmarkInstanceType: "c5n.2xlarge",
    benchmarkNodeCount: 12,
    githubRepository: "owner/repository",
    sourceRepositoryUrl: "https://example.invalid/repository.git",
    nodeVersion: "24.18.1",
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

test("leaves GitHub authentication to manual gh configuration", () => {
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
});
