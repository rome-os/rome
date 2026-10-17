import type { RuntimeStatus } from "./provider";

/**
 * What the shell needs from whichever Rome the main window opens: the local
 * VM (`RuntimeManager`) or a hosted instance (`RemoteRuntime`). Tray, pill,
 * deep links, IPC, and the quit path depend on this, never on the VM.
 */
export interface Runtime {
  getStatus(): RuntimeStatus;
  isReady(): boolean;
  getDashboardUrl(): string;
  ensureReady(): Promise<void>;
  /** Checks for real, unlike `isReady()`, and never starts anything. */
  isServing(): Promise<boolean>;
  stopForQuit(): Promise<void>;
  upgradeRuntime(): Promise<void>;
  openInstallPage(): Promise<void>;
  startRuntimeApp(): Promise<void>;
  openRuntimeFolder(): Promise<void>;
  openLogs(): Promise<void>;
  /** The main window failed to load the dashboard. Only a remote Rome reports it. */
  reportLoadFailure?(detail: string): void;
  /** Stops background work when this runtime is swapped out. */
  dispose?(): void;
  on(event: "status", listener: (status: RuntimeStatus) => void): this;
  removeListener(event: "status", listener: (status: RuntimeStatus) => void): this;
}
