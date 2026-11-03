import type { CloudAccount } from "../cloud/account";
import { RemoteRuntime } from "./remote";
import type { Runtime } from "./runtime";
import { SwitchableRuntime } from "./switchable";
import type { RemoteInstanceRef, RuntimeTarget } from "./target";

export interface RuntimeControllerDeps {
  cloudAccount: CloudAccount;
  savedTarget: RuntimeTarget;
  writeTarget(target: RuntimeTarget): void;
  createRemote(
    instance: RemoteInstanceRef | null,
    onSelect: (ref: RemoteInstanceRef) => void,
  ): RemoteRuntime;
  relaunch(): void;
  /**
   * Opened for this whole launch instead of the saved target. A target picked
   * meanwhile is still saved, and opens on the next launch without it.
   */
  override?: Runtime | null;
}

export type TargetChange = "switched" | "relaunching";

/**
 * Owns which Rome the app has open and every change to it. A change applies
 * in place while nothing is open yet (the welcome screen, a Rome still being
 * set up). Once a dashboard is open, the change is saved and the app
 * relaunches into it.
 */
export class RuntimeController {
  readonly runtime: SwitchableRuntime;
  private active: RuntimeTarget;

  constructor(private readonly deps: RuntimeControllerDeps) {
    this.active = deps.savedTarget;
    this.runtime = new SwitchableRuntime(deps.override ?? this.build(this.active));
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

  /** Signing out lands on the welcome screen. */
  async signOut(): Promise<TargetChange> {
    await this.deps.cloudAccount.signOut();
    return this.setTarget({ kind: "remote", instance: null });
  }

  private canSwitchInPlace(): boolean {
    if (this.deps.override) return false;
    return !this.runtime.isReady();
  }

  private build(target: RuntimeTarget): RemoteRuntime {
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
