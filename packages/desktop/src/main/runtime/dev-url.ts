import { EventEmitter } from "events";
import type { RuntimePhase, RuntimeStatus } from "./provider";
import type { Runtime } from "./runtime";

/** Points an unpackaged build's main window at any Rome, such as a dev stack behind a tunnel. */
export const DEV_DASHBOARD_URL_ENV = "ROME_DESKTOP_DASHBOARD_URL";

/**
 * The origin to open instead of the saved target, or null to open the saved
 * target as usual.
 *
 * A packaged app never reads it, so the override cannot reach users. A value
 * that is not an http(s) URL throws: falling back to the saved target would
 * open a different Rome with no hint that the override was ignored.
 */
export function resolveDevDashboardUrl(
  isPackaged: boolean,
  raw: string | undefined,
): string | null {
  const value = raw?.trim();
  if (isPackaged || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${DEV_DASHBOARD_URL_ENV} must be an http(s) URL; got "${value}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${DEV_DASHBOARD_URL_ENV} must be an http(s) URL; got "${value}".`);
  }
  return url.origin;
}

/**
 * A Rome this computer neither runs nor signs in to: the window opens the URL
 * and the page handles its own sign-in. It counts as ready from the start; a
 * failed load shows the status page, and its retry reopens the URL.
 */
export class DevUrlRuntime extends EventEmitter implements Runtime {
  private status: RuntimeStatus;

  constructor(
    private readonly origin: string,
    private readonly deps: { openLogs(): Promise<void> },
  ) {
    super();
    this.status = this.createStatus("ready", null);
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status.phase === "ready";
  }

  getDashboardUrl(): string {
    return this.origin;
  }

  async ensureReady(): Promise<void> {
    if (!this.isReady()) this.setStatus(this.createStatus("ready", null));
  }

  async isServing(): Promise<boolean> {
    return true;
  }

  async openCloud(): Promise<void> {}

  openLogs(): Promise<void> {
    return this.deps.openLogs();
  }

  reportLoadFailure(detail: string): void {
    this.setStatus(this.createStatus("failed", detail));
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private createStatus(phase: RuntimePhase, error: string | null): RuntimeStatus {
    return {
      phase,
      title: phase === "ready" ? `Connected to ${this.origin}` : `Can't reach ${this.origin}`,
      detail: error ?? `Using ${this.origin} from ${DEV_DASHBOARD_URL_ENV}.`,
      primaryAction: phase === "ready" ? "open_dashboard" : "retry",
      dashboardUrl: this.origin,
      lastError: error,
    };
  }
}
