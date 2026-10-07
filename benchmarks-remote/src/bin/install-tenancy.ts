import { commonFlags, Environment, installTenancy } from "../lib/operations";
import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  ...commonFlags,
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Install benchmark tenancy`,
  });

  const env = new Environment(flags);
  env.credentials();
  installTenancy(env);
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
