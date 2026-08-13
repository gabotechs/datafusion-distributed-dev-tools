import { setTimeout as sleep } from "node:timers/promises";

export async function waitForNextPoll(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await sleep(milliseconds, undefined, { signal });
  } catch (error) {
    if (signal.aborted && isAbortError(error)) return;
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
