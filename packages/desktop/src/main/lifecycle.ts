import { app } from "electron";
import { createLogger } from "./logger";
import type { RuntimeManager } from "./runtime/manager";

type AppWithUpdateQuitEvent = typeof app & {
  on(event: "before-quit-for-update", listener: () => void): typeof app;
};

const log = createLogger("lifecycle");

// Upper bound for the whole quit dance (container SIGTERM + VM stop +
// fallbacks). If the runtime is still wedged after this we hard-exit so
// the user never sits looking at a half-quit Dock icon.
const SHUTDOWN_HARD_TIMEOUT_MS = 45_000;

let shutdownPromise: Promise<void> | null = null;
let shutdownComplete = false;
let quittingForUpdate = false;
let quitting = false;
let runtimeManagerRef: RuntimeManager | null = null;
let onShutdownStartRef: (() => void) | null = null;

/**
 * True once a real quit is in progress (Cmd+Q/app-menu Quit, Stop and quit,
 * SIGINT/SIGTERM, auto-update). The window 'close' interceptor reads this
 * to decide whether to hide the window or let it actually close.
 */
export function isQuitting(): boolean {
  return quitting;
}

export function prepareForUpdateInstall(): Promise<void> {
  quittingForUpdate = true;
  quitting = true;
  return shutdown();
}

async function shutdown(): Promise<void> {
  if (shutdownComplete) return;
  if (shutdownPromise) return shutdownPromise;

  try {
    onShutdownStartRef?.();
  } catch (error) {
    log.error("onShutdownStart callback threw", error);
  }

  shutdownPromise = doShutdown().finally(() => {
    shutdownComplete = true;
  });
  return shutdownPromise;
}

async function doShutdown(): Promise<void> {
  if (!runtimeManagerRef) return;

  // Race the runtime stop against a hard upper bound. Whichever wins, we
  // proceed to app.quit() — quit must never be blocked by a wedged VM.
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      log.warn(`Shutdown exceeded ${SHUTDOWN_HARD_TIMEOUT_MS}ms; abandoning runtime stop`);
      resolve();
    }, SHUTDOWN_HARD_TIMEOUT_MS);
  });

  try {
    await Promise.race([runtimeManagerRef.stopForQuit(), timeout]);
  } catch (error) {
    log.error("runtime stopForQuit threw during shutdown", error);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export interface SetupLifecycleOptions {
  runtimeManager: RuntimeManager;
  onShutdownStart?: () => void;
}

export function setupLifecycle(options: SetupLifecycleOptions): void {
  runtimeManagerRef = options.runtimeManager;
  onShutdownStartRef = options.onShutdownStart ?? null;

  app.on("before-quit", async (event) => {
    if (shutdownComplete || quittingForUpdate) return;
    event.preventDefault();
    quitting = true;
    await shutdown();
    app.quit();
  });

  (app as AppWithUpdateQuitEvent).on("before-quit-for-update", () => {
    quittingForUpdate = true;
    quitting = true;
    void shutdown();
  });

  process.on("SIGINT", async () => {
    quitting = true;
    await shutdown();
    app.quit();
  });

  process.on("SIGTERM", async () => {
    quitting = true;
    await shutdown();
    app.quit();
  });
}

/**
 * Called from UI surfaces (⌘Q / app-menu Quit, tray "Stop agent and quit") to
 * start the full shutdown path. Idempotent — the before-quit handler runs the
 * actual shutdown.
 */
export function requestStopAndQuit(): void {
  quitting = true;
  app.quit();
}
