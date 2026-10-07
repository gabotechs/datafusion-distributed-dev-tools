import { flag, message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { botFlags, command } from "../lib/bot-cli.js";

const Options = object({
  ...botFlags,
  yes: flag("--yes", {
    description: message`Skip Pulumi confirmation`,
  }).withDefault(false),
});
try {
  const options = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Deploy the benchmark bot`,
  });
  command("npm", ["run", "application:build"]);
  command("npm", ["run", "pulumi:build"]);
  command(options.pulumiBin, [
    "up",
    "--stack",
    options.stack,
    ...(options.yes ? ["--yes"] : []),
  ]);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
