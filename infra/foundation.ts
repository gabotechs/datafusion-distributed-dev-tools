import * as aws from "@pulumi/aws";

import { applicationArchive } from "./application.js";
import type { ControllerConfig } from "./config.js";
import { createController } from "./controller.js";
import { createControllerRole } from "./identity.js";

export function createControllerInfrastructure(config: ControllerConfig) {
  const cluster = aws.eks.getClusterOutput({ name: config.clusterName });
  const artifactBucket = new aws.s3.Bucket("bot-artifacts", {
    forceDestroy: true,
    tags: { Name: `${config.namePrefix}-artifacts` },
  });
  new aws.s3.BucketPublicAccessBlock("bot-artifacts-public-access", {
    bucket: artifactBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });
  new aws.s3.BucketVersioning("bot-artifacts-versioning", {
    bucket: artifactBucket.id,
    versioningConfiguration: { status: "Enabled" },
  });
  new aws.s3.BucketPolicy("bot-artifacts-policy", {
    bucket: artifactBucket.id,
    policy: artifactBucket.arn.apply((artifactBucketArn) =>
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowBenchmarkWorkersToReadArtifacts",
            Effect: "Allow",
            Principal: { AWS: config.benchmarkWorkloadRoleArn },
            Action: "s3:GetObject",
            Resource: `${artifactBucketArn}/workers/*`,
          },
          {
            Sid: "RequireTLS",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [artifactBucketArn, `${artifactBucketArn}/*`],
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          },
        ],
      }),
    ),
  });
  const application = new aws.s3.BucketObjectv2("bot-controller-application", {
    bucket: artifactBucket.id,
    key: "controller/application.tar.gz",
    source: applicationArchive(),
  });
  const identity = createControllerRole(config, cluster, artifactBucket);
  const { controller, publicAddress } = createController({
    config,
    application,
    artifactBucketName: artifactBucket.id,
    profile: identity.profile,
    identityDependencies: [identity.policy, identity.ssmAttachment],
  });
  return {
    controller,
    controllerRole: identity.role,
    publicAddress,
    artifactBucket,
  };
}
