import {Command} from "commander";
import fs from "node:fs";
import path from "node:path";

import { compareStoredResults } from "./@compare";

async function main() {
    const program = new Command();

    program
        .requiredOption('--dataset <string>', 'Dataset to run queries on')
        .option('--output <path>', 'Write the comparison to a file instead of stdout')
        .argument("<base_engine>", "the base engine")
        .argument("<compare_engine>", "the engine to compare to")
        .parse(process.argv);

    const options = program.opts();
    if (program.args.length != 2) {
        throw new Error(`Expected exactly 2 arguments, got ${program.args.length}`)
    }

    const comparison = compareStoredResults(options.dataset, program.args[0], program.args[1])
    if (options.output) {
        fs.mkdirSync(path.dirname(options.output), {recursive: true});
        fs.writeFileSync(options.output, `${comparison}\n`);
    } else {
        console.log(comparison)
    }
}

main()
    .catch(err => {
        console.error(err)
        process.exit(1)
    })
