import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { applicationArchive } from "./application.js";
import type { ControllerConfig } from "./config.js";
import { createController } from "./controller.js";
import { createControllerRole } from "./identity.js";

export function createControllerInfrastructure(config: ControllerConfig) {
  const cluster = aws.eks.getClusterOutput({ name: config.clusterName });
  const githubSecret = new aws.secretsmanager.Secret("bot-github-credentials", {
    namePrefix: `${config.namePrefix}-github-`,
  });
  const githubSecretVersion = new aws.secretsmanager.SecretVersion(
    "bot-github-credentials-value",
    {
      secretId: githubSecret.id,
      secretString: pulumi.jsonStringify({
        GITHUB_REPOSITORY: config.githubRepository,
        SOURCE_REPOSITORY_URL: config.sourceRepositoryUrl,
        GITHUB_APP_ID: config.githubAppId,
        GITHUB_INSTALLATION_ID: config.githubInstallationId,
        GITHUB_PRIVATE_KEY: config.githubPrivateKey,
      }),
    },
  );
  const application = new aws.s3.BucketObjectv2("bot-controller-application", {
    bucket: config.datasetBucketName,
    key: ".benchmark-artifacts/pr-bot/controller/application.tar.gz",
    source: applicationArchive(),
  });
  const identity = createControllerRole(config, githubSecret, cluster);
  const { controller, publicAddress } = createController({
    config,
    application,
    githubSecret,
    githubSecretVersion,
    profile: identity.profile,
    identityDependencies: [identity.policy, identity.ssmAttachment],
  });
  return { controller, controllerRole: identity.role, publicAddress };
}
