import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

const EXIT_GRACE_MS = 1_000;

/** Owns one Query's process. Aborting resolves only after that process exits. */
export function createClaudeQueryProcess() {
  const abortController = new AbortController();
  let child: SpawnedProcess | undefined;
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const didExit = () => {
    exited = true;
    resolveExit();
  };
  const waitForExit = async (): Promise<boolean> => {
    if (!child || exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exit.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), EXIT_GRACE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    abortController,
    spawn(options: SpawnOptions): SpawnedProcess {
      const process = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      child = process;
      process.once("exit", didExit);
      process.on("error", () => {
        if (process.pid === undefined) didExit();
      });
      return process;
    },
    async abort(): Promise<void> {
      abortController.abort();
      if (await waitForExit()) return;
      // ChildProcess.killed records signal delivery, not exit. The SDK skips
      // its close-time escalation after abort has already set that flag.
      child!.kill("SIGKILL");
      if (!(await waitForExit())) {
        throw new Error("Claude process did not exit after cancellation");
      }
    },
  };
}
