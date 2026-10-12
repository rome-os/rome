import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const mockServerLog = path.join(tmpdir(), "rome-devmock.log");

async function isReady(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export async function startMockServer(baseUrl: string): Promise<() => Promise<void>> {
  const url = new URL(baseUrl);
  if (await isReady(baseUrl)) return async () => {};
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`External mock server is unavailable: ${url.origin}`);
  }

  // The server serves client assets and must not inherit model credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "PNPM_HOME", "NODE_OPTIONS", "CI"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.MOCK_WEB_PORT = url.port || "80";
  const log = await open(mockServerLog, "w");
  const child = spawn("pnpm", ["--filter", "rome-web", "dev:mock:e2e"], {
    cwd: repositoryRoot,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", log.fd, log.fd],
  });
  let spawnError: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => { spawnError = error; resolve(); });
    child.once("close", () => resolve());
  });
  await log.close();
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const onExit = () => signalGroup("SIGKILL");
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    signalGroup("SIGTERM");
    await Promise.race([closed, delay(5_000, undefined, { ref: false })]);
    signalGroup("SIGKILL");
    process.off("exit", onExit);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  })();
  const onInterrupt = () => { void stop().finally(() => process.exit(130)); };
  const onTerminate = () => { void stop().finally(() => process.exit(143)); };
  process.once("exit", onExit);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    // build:kit runs before the dev server, so a cold start can take minutes.
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Mock server exited before readiness; see ${mockServerLog}`);
      }
      if (await isReady(baseUrl)) return stop;
      await delay(1_000);
    }
    throw new Error(`Mock server readiness timed out; see ${mockServerLog}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
