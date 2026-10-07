import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { message, option, string, withDefault } from "@optique/core";

export const botFlags = {
  stack: withDefault(
    option("--stack", string({ metavar: "NAME" }), {
      description: message`Pulumi stack`,
    }),
    "controller",
  ),
  pulumiBin: withDefault(
    option("--pulumi-bin", string({ metavar: "PATH" }), {
      description: message`Pulumi executable`,
    }),
    "pulumi",
  ),
};

let botRoot = path.dirname(fileURLToPath(import.meta.url));
while (!existsSync(path.join(botRoot, "Pulumi.yaml"))) {
  const parent = path.dirname(botRoot);
  if (parent === botRoot)
    throw new Error("Could not find the benchmark bot project");
  botRoot = parent;
}

export function command(
  program: string,
  args: string[],
  capture = false,
): string {
  const result = spawnSync(program, args, {
    cwd: botRoot,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${program} failed: ${result.error?.message ?? result.signal ?? result.status}`,
    );
  return (result.stdout ?? "").trim();
}
