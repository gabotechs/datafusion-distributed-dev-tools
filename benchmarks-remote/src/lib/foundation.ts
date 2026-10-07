import path from "node:path";
import { remoteRoot, value, type Flags } from "./operations";

export function mergeCidrs(
  configured: unknown,
  live: unknown,
  publicIp: string,
): string[] {
  if (
    typeof configured === "object" &&
    configured !== null &&
    "value" in configured
  )
    configured = configured.value;
  if (typeof configured === "string")
    configured = JSON.parse(configured) as unknown;
  const entries: unknown[] = [
    ...(Array.isArray(configured) ? configured : []),
    ...(Array.isArray(live) ? live : []),
    `${publicIp}/32`,
  ];
  return [
    ...new Set(
      entries.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry !== "0.0.0.0/0",
      ),
    ),
  ].sort();
}
export function foundationPaths(flags: Flags): {
  outputs: string;
  kubeconfig: string;
} {
  const stack = value(flags, "stack", "benchmark");
  if (!/^[a-zA-Z0-9_-]+$/.test(stack))
    throw new Error(
      "--stack must be a local stack name containing letters, digits, underscores or hyphens",
    );
  const suffix = stack === "benchmark" ? "" : `.${stack}`;
  return {
    outputs: path.resolve(
      value(
        flags,
        "outputs-file",
        path.join(remoteRoot, `pulumi/.pulumi-outputs${suffix}.json`),
      ),
    ),
    kubeconfig: path.resolve(
      value(
        flags,
        "kubeconfig",
        path.join(remoteRoot, `k8s/.kubeconfig${suffix}`),
      ),
    ),
  };
}
