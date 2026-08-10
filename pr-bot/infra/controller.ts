import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import type { ControllerConfig } from "./config.js";
import { renderControllerSetup } from "./setup.js";

export interface ControllerArguments {
  config: ControllerConfig;
  application: aws.s3.BucketObjectv2;
  artifactBucketName: pulumi.Output<string>;
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
    .all([args.application.key, args.artifactBucketName])
    .apply(([applicationKey, artifactBucketName]) =>
      renderControllerSetup({
        config,
        applicationKey,
        artifactBucketName,
      }),
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
