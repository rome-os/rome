import { EventEmitter } from "events";
import type { RuntimeStatus } from "./provider";
import type { Runtime } from "./runtime";

/**
 * The one runtime every part of the shell holds, standing in for whichever
 * Rome is open now. The welcome screen can hand it a different hosted Rome
 * without a relaunch, because nothing has opened yet at that point.
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

  openCloud(): Promise<void> {
    return this.current.openCloud();
  }

  openLogs(): Promise<void> {
    return this.current.openLogs();
  }

  reportLoadFailure(detail: string): void {
    this.current.reportLoadFailure(detail);
  }

  dispose(): void {
    this.current.dispose?.();
  }
}
