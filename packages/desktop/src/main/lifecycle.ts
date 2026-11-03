import { app } from "electron";
import { createLogger } from "./logger";

type AppWithUpdateQuitEvent = typeof app & {
  on(event: "before-quit-for-update", listener: () => void): typeof app;
};

const log = createLogger("lifecycle");

// Disconnecting this computer as a device only closes a socket, so quit waits
// for it briefly and then goes anyway: a quit must never hang on the network.
const SHUTDOWN_TIMEOUT_MS = 3_000;

let shutdownPromise: Promise<void> | null = null;
let shutdownComplete = false;
let quittingForUpdate = false;
let quitting = false;
let onShutdownRef: (() => Promise<void>) | null = null;

/**
 * True once a real quit is in progress (Cmd+Q/app-menu Quit, the tray's Quit,
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

function shutdown(): Promise<void> {
  if (shutdownComplete) return Promise.resolve();
  shutdownPromise ??= runShutdown(onShutdownRef).finally(() => {
    shutdownComplete = true;
  });
  return shutdownPromise;
}

/** Runs the shutdown work, bounded by `timeoutMs`; never rejects. */
export async function runShutdown(
  work: (() => Promise<void>) | null,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!work) return;
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`Shutdown exceeded ${timeoutMs}ms; quitting anyway`);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([work(), timeout]);
  } catch (error) {
    log.error("Shutdown work threw", error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SetupLifecycleOptions {
  /** Work to finish before the app exits: disconnecting this computer as a device. */
  onShutdown: () => Promise<void>;
}

export function setupLifecycle(options: SetupLifecycleOptions): void {
  onShutdownRef = options.onShutdown;

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
 * Called from UI surfaces (⌘Q / app-menu Quit, tray and floating icon "Quit
 * Rome") to start the shutdown path. Idempotent — the before-quit handler runs
 * the actual shutdown.
 */
export function requestStopAndQuit(): void {
  quitting = true;
  app.quit();
}
