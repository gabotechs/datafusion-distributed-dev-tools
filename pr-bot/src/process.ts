import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  quiet?: boolean;
  outputTailBytes?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    program: string,
    arguments_: readonly string[],
    options?: RunOptions,
  ): Promise<RunResult>;
}

export class LocalProcessRunner implements ProcessRunner {
  async run(
    program: string,
    arguments_: readonly string[],
    options: RunOptions = {},
  ): Promise<RunResult> {
    if (
      options.outputTailBytes !== undefined &&
      (!Number.isSafeInteger(options.outputTailBytes) ||
        options.outputTailBytes <= 0)
    ) {
      throw new Error("outputTailBytes must be a positive safe integer");
    }
    return await new Promise((resolve, reject) => {
      const child = spawn(program, [...arguments_], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = appendOutput(stdout, chunk, options.outputTailBytes);
        if (!options.quiet) process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = appendOutput(stderr, chunk, options.outputTailBytes);
        if (!options.quiet) process.stderr.write(chunk);
      });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        const result = { exitCode: exitCode ?? 1, stdout, stderr };
        if (result.exitCode !== 0 && !options.allowFailure) {
          reject(
            new Error(
              `${program} exited with ${result.exitCode}\n${stderr || stdout}`,
            ),
          );
        } else {
          resolve(result);
        }
      });
    });
  }
}

function appendOutput(
  captured: string,
  chunk: string,
  outputTailBytes: number | undefined,
): string {
  const combined = captured + chunk;
  if (outputTailBytes === undefined) return combined;
  const bytes = Buffer.from(combined);
  if (bytes.length <= outputTailBytes) return combined;

  let start = bytes.length - outputTailBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
