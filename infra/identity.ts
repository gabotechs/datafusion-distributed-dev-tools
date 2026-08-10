import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "./config.js";

export function createControllerRole(
  config: ControllerConfig,
  cluster: pulumi.Output<aws.eks.GetClusterResult>,
) {
  const role = new aws.iam.Role("bot-controller-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: "ec2.amazonaws.com",
    }),
    tags: { Name: `${config.namePrefix}-controller` },
  });
  const ssmAttachment = new aws.iam.RolePolicyAttachment("bot-controller-ssm", {
    role: role.name,
    policyArn: aws.iam.ManagedPolicy.AmazonSSMManagedInstanceCore,
  });
  const policy = new aws.iam.RolePolicy("bot-controller-policy", {
    role: role.id,
    policy: cluster.arn.apply((clusterArn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ManageBotArtifacts",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
            Resource: `arn:aws:s3:::${config.datasetBucketName}/.benchmark-artifacts/pr-bot/*`,
          },
          {
            Sid: "DiscoverDatasetsAndArtifacts",
            Effect: "Allow",
            Action: ["s3:ListBucket", "s3:GetBucketLocation"],
            Resource: `arn:aws:s3:::${config.datasetBucketName}`,
          },
          {
            Sid: "ConnectToBenchmarkCluster",
            Effect: "Allow",
            Action: "eks:DescribeCluster",
            Resource: clusterArn,
          },
        ],
      }),
    ),
  });
  const profile = new aws.iam.InstanceProfile("bot-controller-profile", {
    role: role.name,
  });
  return { role, profile, policy, ssmAttachment };
}
