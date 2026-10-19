import { EventEmitter } from "events";
import { type CloudInstance, NativeAuthError } from "@rome-os/libs/native-auth";
import type { CloudAccount } from "../cloud/account";
import { createLogger } from "../logger";
import type { RuntimeAction, RuntimePhase, RuntimeStatus } from "./provider";
import type { Runtime } from "./runtime";
import type { RemoteInstanceRef } from "./target";

const log = createLogger("remote-runtime");
const HEALTH_TIMEOUT_MS = 10_000;
// Provisioning finishes on its own, so it is worth watching closely. A Rome
// that waits on the user (stopped, or not created yet) changes only when they
// act in Rome Cloud, so a slower look is enough.
const PROVISIONING_POLL_MS = 5_000;
const WAITING_POLL_MS = 15_000;
const PLACEHOLDER_URL = "https://romeos.cc";

export interface RemoteRuntimeDeps {
  account: Pick<CloudAccount, "isSignedIn" | "listInstances" | "openSession">;
  fetchImpl: typeof fetch;
  openLogs(): Promise<void>;
  /** Opens the user's Rome Cloud dashboard in the browser. */
  openCloud(): Promise<void>;
  /** Saves the instance this runtime settled on, so the next launch opens it directly. */
  onSelect(instance: RemoteInstanceRef): void;
}

function refOf(instance: CloudInstance): RemoteInstanceRef {
  return { id: instance.id, name: instance.name, origin: instance.origin };
}

/**
 * A hosted Rome from the user's Rome Cloud account, opened instead of the
 * local VM. Getting ready means: be signed in, settle on an instance (the only
 * one picks itself), wait for it to run, install a fresh instance session in
 * the window's cookies, and see it answer. A state only the user can change
 * is `waiting_for_user`, and the ones Rome Cloud resolves by itself are polled.
 * Nothing runs on this computer, so quitting stops nothing.
 */
export class RemoteRuntime extends EventEmitter implements Runtime {
  private status: RuntimeStatus;
  private inFlight: Promise<void> | null = null;
  private poll: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private instance: RemoteInstanceRef | null,
    private readonly deps: RemoteRuntimeDeps,
  ) {
    super();
    this.status = this.connectingStatus();
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status.phase === "ready";
  }

  getDashboardUrl(): string {
    return this.instance?.origin ?? PLACEHOLDER_URL;
  }

  ensureReady(): Promise<void> {
    return this.run(false);
  }

  // A background poll keeps the current screen until something changes, so
  // a waiting page does not flash "Connecting" every few seconds.
  private run(background: boolean): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.connect(background).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  /** The user picked one of several instances. */
  async chooseInstance(instanceId: string): Promise<void> {
    const listed = (await this.deps.account.listInstances()).find(
      (candidate) => candidate.id === instanceId,
    );
    if (this.disposed) return;
    if (!listed) throw new Error("That Rome is no longer in your account.");
    this.select(listed);
    await this.ensureReady();
  }

  isServing(): Promise<boolean> {
    return this.instance ? this.probeHealth(this.instance.origin) : Promise.resolve(false);
  }

  /**
   * Called when this runtime is swapped out or the app quits. Work already in
   * flight keeps running, so every step after an await checks this and stops
   * before it saves a pick, installs a session, or reports a status: a late
   * answer from Rome Cloud must not undo the user's switch.
   */
  dispose(): void {
    this.disposed = true;
    this.clearPoll();
  }

  async stopForQuit(): Promise<void> {
    this.dispose();
  }

  async upgradeRuntime(): Promise<void> {}

  openInstallPage(): Promise<void> {
    return this.deps.openCloud();
  }

  async startRuntimeApp(): Promise<void> {}

  async openRuntimeFolder(): Promise<void> {}

  openLogs(): Promise<void> {
    return this.deps.openLogs();
  }

  reportLoadFailure(detail: string): void {
    this.fail(`Can't reach ${this.instance?.name ?? "your Rome"}`, detail);
  }

  private async connect(background: boolean): Promise<void> {
    this.clearPoll();
    if (this.disposed) return;
    if (!background) this.setStatus(this.connectingStatus());
    try {
      const signedIn = await this.deps.account.isSignedIn();
      if (this.disposed) return;
      if (!signedIn) {
        this.waitForUser(
          "sign_in",
          "Welcome to Rome",
          "Sign in with your Rome Cloud account to open your Rome.",
        );
        return;
      }
      const instances = await this.deps.account.listInstances();
      if (this.disposed) return;
      const instance = this.pick(instances);
      if (!instance) return;
      await this.open(instance);
    } catch (err) {
      if (!this.disposed) this.failFrom(err);
    }
  }

  /**
   * The saved instance if Rome Cloud still lists it, else the only one there
   * is. Several with none saved is the one case that asks the user.
   */
  private pick(instances: CloudInstance[]): CloudInstance | null {
    const saved =
      this.instance && instances.find((candidate) => candidate.id === this.instance?.id);
    const picked = saved || (instances.length === 1 ? instances[0] : null);
    if (picked) {
      this.select(picked);
      return picked;
    }
    if (instances.length === 0) {
      this.instance = null;
      this.waitForUser(
        "open_cloud",
        "You don't have a Rome yet",
        "Create one in Rome Cloud. Rome opens it here as soon as it is ready.",
      );
      this.schedule(WAITING_POLL_MS);
      return null;
    }
    this.instance = null;
    this.waitForUser(
      "choose_instance",
      "Choose a Rome",
      "Your Rome Cloud account has more than one. Pick the one to open.",
    );
    return null;
  }

  private async open(instance: CloudInstance): Promise<void> {
    const name = instance.name;
    if (instance.status === "provisioning") {
      this.setPhase(
        "starting_rome",
        `Setting up ${name}`,
        "Rome Cloud is preparing your Rome. This takes a few minutes.",
        "none",
      );
      this.schedule(PROVISIONING_POLL_MS);
      return;
    }
    if (instance.status !== "running") {
      this.waitForUser(
        "open_cloud",
        `${name} is ${instance.status}`,
        "Start it from your Rome Cloud dashboard. Rome opens it here as soon as it is running.",
      );
      this.schedule(WAITING_POLL_MS);
      return;
    }
    await this.deps.account.openSession(instance);
    if (this.disposed) return;
    this.setPhase("waiting_for_health", `Connecting to ${name}`, "Waiting for your Rome.", "none");
    const healthy = await this.probeHealth(instance.origin);
    if (this.disposed) return;
    if (!healthy) {
      this.fail(`Can't reach ${name}`, `${instance.origin} did not answer.`);
      return;
    }
    this.setPhase("ready", `Connected to ${name}`, `Using ${instance.origin}.`, "open_dashboard");
  }

  private select(instance: CloudInstance): void {
    if (this.disposed) return;
    const next = refOf(instance);
    const current = this.instance;
    this.instance = next;
    // The origin and name follow Rome Cloud, so a rename or move is saved too.
    if (
      !current ||
      current.id !== next.id ||
      current.origin !== next.origin ||
      current.name !== next.name
    ) {
      this.deps.onSelect(next);
    }
  }

  private failFrom(err: unknown): void {
    const name = this.instance?.name ?? "your Rome";
    if (!(err instanceof NativeAuthError)) {
      log.error("Connecting to the remote Rome failed", err);
      this.fail(`Can't connect to ${name}`, err instanceof Error ? err.message : String(err));
      return;
    }
    switch (err.code) {
      case "cloud_unauthorized":
        this.waitForUser(
          "sign_in",
          "Sign in to Rome Cloud",
          "Your Rome Cloud sign-in has ended. Sign in again to open your Rome.",
        );
        return;
      case "instance_not_ready":
        this.setPhase("starting_rome", `${name} is starting`, "Waiting for it to finish.", "none");
        this.schedule(PROVISIONING_POLL_MS);
        return;
      case "network":
        this.fail(`Can't reach ${name}`, "Check your internet connection, then try again.");
        return;
      default:
        this.fail(`Can't sign in to ${name}`, err.message);
    }
  }

  private schedule(delayMs: number): void {
    this.clearPoll();
    if (this.disposed) return;
    this.poll = setTimeout(() => {
      this.poll = null;
      void this.run(true);
    }, delayMs);
  }

  private clearPoll(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }

  private async probeHealth(origin: string): Promise<boolean> {
    try {
      const response = await this.deps.fetchImpl(`${origin}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private connectingStatus(): RuntimeStatus {
    return this.createStatus(
      "starting_rome",
      this.instance ? `Connecting to ${this.instance.name}` : "Connecting to Rome Cloud",
      "Signing in to your Rome.",
      "none",
    );
  }

  private waitForUser(action: RuntimeAction, title: string, detail: string): void {
    this.setPhase("waiting_for_user", title, detail, action);
  }

  private fail(title: string, detail: string): void {
    this.setPhase("failed", title, detail, "retry");
  }

  private createStatus(
    phase: RuntimePhase,
    title: string,
    detail: string,
    primaryAction: RuntimeAction,
  ): RuntimeStatus {
    const dashboardUrl = this.getDashboardUrl();
    return {
      phase,
      title,
      detail,
      primaryAction,
      dashboardUrl,
      healthUrl: `${dashboardUrl}/api/health`,
      installDir: "",
      image: "",
      containerName: "",
      provider: "remote",
      runtimeInstalled: true,
      runtimeRunning: phase === "ready",
      runtimeInstallUrl: "",
      lastError: phase === "failed" ? detail : null,
      pullProgress: null,
    };
  }

  private setPhase(
    phase: RuntimePhase,
    title: string,
    detail: string,
    primaryAction: RuntimeAction,
  ): void {
    this.setStatus(this.createStatus(phase, title, detail, primaryAction));
    log.info(`${title}: ${detail}`);
  }

  private setStatus(status: RuntimeStatus): void {
    if (this.disposed) return;
    this.status = status;
    this.emit("status", this.status);
  }
}
