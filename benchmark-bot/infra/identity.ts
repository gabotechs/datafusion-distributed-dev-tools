import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "./config.js";

export function createControllerRole(
  config: ControllerConfig,
  cluster: pulumi.Output<aws.eks.GetClusterResult>,
  artifactBucket: aws.s3.Bucket,
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
    policy: pulumi
      .all([cluster.arn, artifactBucket.arn])
      .apply(([clusterArn, artifactBucketArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "ReadControllerApplication",
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:GetObjectVersion"],
              Resource: `${artifactBucketArn}/controller/*`,
            },
            {
              Sid: "ManageWorkerArtifacts",
              Effect: "Allow",
              Action: [
                "s3:GetObject",
                "s3:PutObject",
                "s3:AbortMultipartUpload",
              ],
              Resource: `${artifactBucketArn}/workers/*`,
            },
            {
              Sid: "DiscoverDatasets",
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
            {
              Sid: "PublishControllerMetrics",
              Effect: "Allow",
              Action: "cloudwatch:PutMetricData",
              Resource: "*",
              Condition: {
                StringEquals: {
                  "cloudwatch:namespace": "DataFusionPRBot",
                },
              },
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
