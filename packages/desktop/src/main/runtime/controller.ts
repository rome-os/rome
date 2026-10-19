import type { CloudAccount } from "../cloud/account";
import { RemoteRuntime } from "./remote";
import type { Runtime } from "./runtime";
import { SwitchableRuntime } from "./switchable";
import type { RemoteInstanceRef, RuntimeTarget } from "./target";

export interface RuntimeControllerDeps {
  /** Null when this build's Rome Cloud origin cannot back a sign-in. */
  cloudAccount: CloudAccount | null;
  savedTarget: RuntimeTarget;
  writeTarget(target: RuntimeTarget): void;
  createLocal(): Runtime;
  createRemote(
    instance: RemoteInstanceRef | null,
    onSelect: (ref: RemoteInstanceRef) => void,
  ): RemoteRuntime;
  relaunch(): void;
}

export type TargetChange = "switched" | "relaunching";

/**
 * Owns which Rome the app has open and every change to it. A change applies
 * in place while nothing is open yet (the welcome screen, a Rome still being
 * set up), since there is nothing to stop. Once a dashboard is open, or the
 * VM is running, the change is saved and the app relaunches into it.
 */
export class RuntimeController {
  readonly runtime: SwitchableRuntime;
  private active: RuntimeTarget;

  constructor(private readonly deps: RuntimeControllerDeps) {
    // A remote target this build cannot sign in to opens the VM instead of a
    // window that can only fail.
    this.active =
      deps.savedTarget.kind === "remote" && !deps.cloudAccount
        ? { kind: "local" }
        : deps.savedTarget;
    this.runtime = new SwitchableRuntime(this.build(this.active));
  }

  activeTarget(): RuntimeTarget {
    return this.active;
  }

  setTarget(target: RuntimeTarget): TargetChange {
    this.deps.writeTarget(target);
    if (!this.canSwitchInPlace()) {
      this.deps.relaunch();
      return "relaunching";
    }
    this.active = target;
    this.runtime.replace(this.build(target));
    void this.runtime.ensureReady();
    return "switched";
  }

  chooseInstance(instanceId: string): Promise<void> {
    const inner = this.runtime.inner;
    if (!(inner instanceof RemoteRuntime)) throw new Error("Rome is not in Rome Cloud mode.");
    return inner.chooseInstance(instanceId);
  }

  /** Signing out of Rome Cloud mode lands on the welcome screen, never on the VM. */
  async signOut(): Promise<TargetChange | null> {
    if (!this.deps.cloudAccount) throw new Error("This build cannot sign in to Rome Cloud.");
    await this.deps.cloudAccount.signOut();
    if (this.active.kind !== "remote") return null;
    return this.setTarget({ kind: "remote", instance: null });
  }

  private canSwitchInPlace(): boolean {
    return this.active.kind === "remote" && !this.runtime.isReady();
  }

  private build(target: RuntimeTarget): Runtime {
    if (target.kind === "local") return this.deps.createLocal();
    const remote = this.deps.createRemote(target.instance, (instance) => {
      // Only the runtime that is open may save its pick. One the user has
      // already switched away from can still finish a request late.
      if (this.runtime.inner !== remote) return;
      const next: RuntimeTarget = { kind: "remote", instance };
      this.active = next;
      this.deps.writeTarget(next);
    });
    return remote;
  }
}
