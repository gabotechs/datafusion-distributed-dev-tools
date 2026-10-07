import { message, object, option, optional, string } from "@optique/core";
import { runSync } from "@optique/run";
import { botFlags, command } from "../lib/bot-cli.js";

const Options = object({
  ...botFlags,
  region: optional(
    option("--region", string({ metavar: "REGION" }), {
      description: message`AWS region (defaults to the caller's AWS configuration)`,
    }),
  ),
});
try {
  const options = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Open an AWS Systems Manager session on the benchmark bot`,
  });
  const instance = command(
    options.pulumiBin,
    ["stack", "output", "controllerInstanceId", "--stack", options.stack],
    true,
  );
  if (!/^i-[0-9a-f]{8}(?:[0-9a-f]{9})?$/.test(instance))
    throw new Error(
      "The selected stack has no valid controllerInstanceId output",
    );
  command("aws", [
    ...(options.region ? ["--region", options.region] : []),
    "ssm",
    "start-session",
    "--target",
    instance,
  ]);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
