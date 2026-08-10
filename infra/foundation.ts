import * as aws from "@pulumi/aws";

import { applicationArchive } from "./application.js";
import type { ControllerConfig } from "./config.js";
import { createController } from "./controller.js";
import { createControllerRole } from "./identity.js";

export function createControllerInfrastructure(config: ControllerConfig) {
  const cluster = aws.eks.getClusterOutput({ name: config.clusterName });
  const application = new aws.s3.BucketObjectv2("bot-controller-application", {
    bucket: config.datasetBucketName,
    key: ".benchmark-artifacts/pr-bot/controller/application.tar.gz",
    source: applicationArchive(),
  });
  const identity = createControllerRole(config, cluster);
  const { controller, publicAddress } = createController({
    config,
    application,
    profile: identity.profile,
    identityDependencies: [identity.policy, identity.ssmAttachment],
  });
  return { controller, controllerRole: identity.role, publicAddress };
}
