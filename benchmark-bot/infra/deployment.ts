import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function controllerDeployCommand(
  bucket: string,
  key: string,
  versionId: string,
  repositoryUrl: string,
): string {
  return `set -euo pipefail
for attempt in $(seq 1 720); do
  [[ -f /var/lib/cloud/instance/boot-finished ]] && break
  sleep 5
done
[[ -f /var/lib/cloud/instance/boot-finished ]]
deployment=$(mktemp -d)
trap 'rm --recursive --force "\${deployment}"' EXIT
aws s3api get-object \
  --bucket ${shellQuote(bucket)} \
  --key ${shellQuote(key)} \
  --version-id ${shellQuote(versionId)} \
  "\${deployment}/application.zip"
unzip -p "\${deployment}/application.zip" controller/install-release \
  > "\${deployment}/install-release"
chmod 0755 "\${deployment}/install-release"
"\${deployment}/install-release" \
  "\${deployment}/application.zip" \
  ${shellQuote(repositoryUrl)}
systemctl is-active --quiet datafusion-pr-bot.service`;
}

export function deployControllerApplication(
  controller: aws.ec2.Instance,
  application: aws.s3.BucketObjectv2,
  repositoryUrl: string,
  dependencies: pulumi.Resource[],
): aws.ssm.Association {
  const commands = pulumi
    .all([application.bucket, application.key, application.versionId])
    .apply(([bucket, key, versionId]) => {
      if (!versionId)
        throw new Error("Controller application has no S3 version");
      return controllerDeployCommand(bucket, key, versionId, repositoryUrl);
    });

  return new aws.ssm.Association(
    "bot-controller-deployment",
    {
      associationName: "datafusion-pr-bot-controller-deployment",
      name: "AWS-RunShellScript",
      parameters: {
        commands,
        executionTimeout: "3600",
      },
      targets: [{ key: "InstanceIds", values: [controller.id] }],
      waitForSuccessTimeoutSeconds: 3600,
    },
    { dependsOn: [application, controller, ...dependencies] },
  );
}
