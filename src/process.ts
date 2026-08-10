import { spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  quiet?: boolean;
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
        stdout += chunk;
        if (!options.quiet) process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
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
