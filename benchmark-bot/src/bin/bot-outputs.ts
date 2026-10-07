import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { botFlags, command } from "../lib/bot-cli.js";

const Options = object(botFlags);
try {
  const options = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Print benchmark bot stack outputs as JSON`,
  });
  command(options.pulumiBin, [
    "stack",
    "output",
    "--stack",
    options.stack,
    "--json",
  ]);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
