import fs from "node:fs";
import path from "node:path";
import { argument, message, object, string } from "@optique/core";
import { runSync } from "@optique/run";
import { errorMessage } from "../lib/filesystem";

const Options = object({
  directory: argument(string({ metavar: "RESULT_DIRECTORY" })),
});
try {
  const flags = runSync(Options, {
    help: "option",
    showDefault: true,
    description: message`Sum successful iteration tasks`,
  });
  const { directory } = flags;

  const files = fs
    .readdirSync(directory)
    .filter((file) => /^q.*\.json$/.test(file));
  if (!files.length)
    throw new Error(`No q*.json result files found in ${directory}`);
  let total = 0;
  for (const file of files) {
    const result = JSON.parse(
      fs.readFileSync(path.join(directory, file), "utf8"),
    ) as { iterations: { error?: unknown; tasks?: number }[] };
    for (const iteration of result.iterations)
      if (iteration.error == null) total += iteration.tasks ?? 0;
  }
  console.log(total);
} catch (error: unknown) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}
