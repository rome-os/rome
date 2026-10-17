import { EventEmitter } from "events";
import type { RuntimeStatus } from "./provider";
import type { Runtime } from "./runtime";

/**
 * The one runtime every part of the shell holds, standing in for whichever
 * Rome is open now. The welcome screen can hand it a different runtime (the
 * private VM, or another hosted Rome) without a relaunch, because nothing has
 * started yet at that point.
 */
export class SwitchableRuntime extends EventEmitter implements Runtime {
  private readonly forward = (status: RuntimeStatus) => this.emit("status", status);

  constructor(private current: Runtime) {
    super();
    current.on("status", this.forward);
  }

  get inner(): Runtime {
    return this.current;
  }

  replace(next: Runtime): void {
    this.current.removeListener("status", this.forward);
    this.current.dispose?.();
    this.current = next;
    next.on("status", this.forward);
    this.emit("status", next.getStatus());
  }

  getStatus(): RuntimeStatus {
    return this.current.getStatus();
  }

  isReady(): boolean {
    return this.current.isReady();
  }

  getDashboardUrl(): string {
    return this.current.getDashboardUrl();
  }

  ensureReady(): Promise<void> {
    return this.current.ensureReady();
  }

  isServing(): Promise<boolean> {
    return this.current.isServing();
  }

  stopForQuit(): Promise<void> {
    return this.current.stopForQuit();
  }

  upgradeRuntime(): Promise<void> {
    return this.current.upgradeRuntime();
  }

  openInstallPage(): Promise<void> {
    return this.current.openInstallPage();
  }

  startRuntimeApp(): Promise<void> {
    return this.current.startRuntimeApp();
  }

  openRuntimeFolder(): Promise<void> {
    return this.current.openRuntimeFolder();
  }

  openLogs(): Promise<void> {
    return this.current.openLogs();
  }

  reportLoadFailure(detail: string): void {
    this.current.reportLoadFailure?.(detail);
  }
}
