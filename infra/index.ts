import { loadControllerConfig } from "./config.js";
import { createControllerInfrastructure } from "./foundation.js";

const config = loadControllerConfig();
const { controller, controllerRole, publicAddress } =
  createControllerInfrastructure(config);

export const controllerInstanceId = controller.id;
export const controllerRoleArn = controllerRole.arn;
export const controllerPublicIp = publicAddress.publicIp;
export const clusterName = config.clusterName;
export const datasetBucketName = config.datasetBucketName;
