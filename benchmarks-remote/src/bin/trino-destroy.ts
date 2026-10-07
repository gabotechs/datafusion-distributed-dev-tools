import { message, object } from "@optique/core";
import { runSync } from "@optique/run";
import { destroyDeployment, destroyFlags } from "../lib/deployment";
import { errorMessage } from "../lib/filesystem";

const Options = object(destroyFlags);
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Destroy Trino`,
  });
  destroyDeployment("trino", flags);
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
