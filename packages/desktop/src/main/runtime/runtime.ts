import type { RuntimeStatus } from "./provider";

/**
 * What the shell needs from whichever Rome the main window opens: a hosted
 * instance (`RemoteRuntime`), or a dev URL (`DevUrlRuntime`). Tray, pill, deep
 * links and IPC depend on this. Nothing runs on this computer, so quitting
 * stops nothing.
 */
export interface Runtime {
  getStatus(): RuntimeStatus;
  isReady(): boolean;
  getDashboardUrl(): string;
  ensureReady(): Promise<void>;
  /** Checks for real, unlike `isReady()`, and never starts anything. */
  isServing(): Promise<boolean>;
  /** Opens the user's Rome Cloud dashboard in the browser. */
  openCloud(): Promise<void>;
  openLogs(): Promise<void>;
  /** The main window failed to load the dashboard. */
  reportLoadFailure(detail: string): void;
  /** Stops background work when this runtime is swapped out or the app quits. */
  dispose?(): void;
  on(event: "status", listener: (status: RuntimeStatus) => void): this;
  removeListener(event: "status", listener: (status: RuntimeStatus) => void): this;
}
