// The WeChat app: the desktop client on WeChat's own desktop, which the guardian
// installs from /desktop/wechat and Rome then keeps running. Independent of the
// WeChat connection (connections/integrations/wechat-user.ts): the app runs
// without one, and a connection reads the same client when the guardian adds it.

import type {
  WechatAppState,
  WechatAppStatus as WechatAppResponse,
} from "@rome/api-types/wechat-app";
import type { WechatUserRuntime } from "../channels/wechat-user.js";
import { createLogger } from "../logger.js";

const log = createLogger("wechat-app");

/** How often the app checks the client. A crashed client is back within two. */
const WATCH_INTERVAL_MS = 15_000;
/** Restarts within `CRASH_WINDOW_MS` after which the app stops restarting. */
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 5 * 60_000;

/** The app's state on an instance with WeChat enabled. */
export type WechatAppStatus = Omit<WechatAppResponse, "state"> & {
  state: Exclude<WechatAppState, "unavailable">;
};

export type WechatAppRuntime = Pick<
  WechatUserRuntime,
  | "installed"
  | "install"
  | "installInFlight"
  | "captureInProgress"
  | "start"
  | "pid"
  | "lastExit"
  | "clientDisplay"
  | "display"
  | "clientLog"
>;

/**
 * Installs the WeChat client on demand and keeps it running once installed.
 *
 * - Rome starts an installed client when it boots, and after the client crashes.
 * - A client the guardian quits, which exits 0, stays stopped until the next
 *   Install, Start or Rome restart. So does a client the app did not launch,
 *   which records no exit status, and one whose start failed.
 * - After `CRASH_LIMIT` restarts within `CRASH_WINDOW_MS`, the app stops
 *   restarting and reports why, so a client that cannot run does not loop.
 *
 * Install and start run in the background, because a download takes minutes,
 * and the page polls `status()`. One runs at a time: a second request joins it.
 */
export class WechatApp {
  private job: { kind: "installing" | "starting"; done: Promise<void> } | null = null;
  private error: string | undefined;
  private restarts: number[] = [];
  private gaveUp = false;
  /** Rome restarting counts as starting it again, even after a quit. */
  private booted = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(
    private readonly runtime: WechatAppRuntime,
    private readonly now: () => number = Date.now,
  ) {}

  async status(): Promise<WechatAppStatus> {
    if (this.job) return { state: this.job.kind };
    // The connection's setup installs through the same runtime. Reporting its
    // install keeps the page from offering a second one.
    if (this.runtime.installInFlight) return { state: "installing" };
    const error = this.error ? { error: this.error } : {};
    if (!(await this.runtime.installed())) return { state: "absent", ...error };
    // The connection's key capture is relaunching the client under a debugger,
    // and the guardian signs in on this desktop while it does.
    if (this.runtime.captureInProgress) return { state: "running" };
    const pid = await this.runtime.pid();
    if (!pid) {
      // Starting: Rome has not booted the client yet, or it crashed and a check
      // restarts it. Otherwise Rome will not start it: it gave up, the last
      // start failed, or the client exited without a crash.
      if (!this.gaveUp && !this.error && (!this.booted || (await this.crashed()))) {
        return { state: "starting" };
      }
      return { state: "stopped", ...error };
    }
    // A failure is about an attempt that has since been overtaken.
    this.error = undefined;
    // A client on the shared desktop, such as one started before WeChat had its
    // own, stays there until it next exits; WeChat's own desktop is empty.
    if ((await this.runtime.clientDisplay(pid)) !== this.runtime.display) {
      return { state: "running", sharedDesktop: true };
    }
    return { state: "running" };
  }

  /** Download the client if needed, then open it. */
  install(): Promise<WechatAppStatus> {
    this.resetRestarts();
    return this.run("installing", async () => {
      await this.runtime.install();
      await this.runtime.start();
    });
  }

  /** Open the downloaded client. */
  async start(): Promise<WechatAppStatus> {
    if (!this.job && !this.runtime.installInFlight && !(await this.runtime.installed())) {
      throw new WechatAppNotInstalled();
    }
    this.resetRestarts();
    return this.run("starting", () => this.runtime.start());
  }

  /** Check the client now and every `WATCH_INTERVAL_MS`, starting it as the
   *  rules above say. */
  watch(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async unwatch(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /** One check. Public for tests; `watch()` calls it on a timer. */
  tick(): Promise<void> {
    this.ticking ??= this.check().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Resolves when no install or start is running. For tests. */
  async settled(): Promise<void> {
    await this.job?.done;
  }

  private async check(): Promise<void> {
    const boot = !this.booted;
    try {
      if (this.job || this.runtime.installInFlight || this.runtime.captureInProgress) return;
      if (!(await this.runtime.installed())) return;
      if (await this.runtime.pid()) return;
      // A failed start stays stopped, like a quit, until the guardian acts.
      if (this.gaveUp || this.error) return;
      if (!boot && !(await this.crashed())) return;
      if (!boot) {
        const since = this.now() - CRASH_WINDOW_MS;
        this.restarts = this.restarts.filter((at) => at > since);
        if (this.restarts.length >= CRASH_LIMIT) {
          this.gaveUp = true;
          this.error = `WeChat exited ${CRASH_LIMIT} times in 5 minutes. Its log is at ${this.runtime.clientLog}`;
          log.warn("wechat_app.crash_loop", { restarts: this.restarts.length });
          return;
        }
        this.restarts.push(this.now());
        log.info("wechat_app.restarting", { exit: await this.runtime.lastExit() });
      }
      await this.run("starting", () => this.runtime.start());
    } catch (error) {
      log.warn("wechat_app.check_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.booted = true;
    }
  }

  /**
   * Whether the last client the app launched crashed: it recorded a non-zero
   * exit status. A quit records 0. A client launched another way, such as the
   * connection's key capture, records nothing, and the app leaves it alone.
   */
  private async crashed(): Promise<boolean> {
    const exit = await this.runtime.lastExit();
    return exit !== null && exit !== 0;
  }

  private resetRestarts(): void {
    this.restarts = [];
    this.gaveUp = false;
  }

  private async run(
    kind: "installing" | "starting",
    work: () => Promise<void>,
  ): Promise<WechatAppStatus> {
    // The connection's setup installs without starting, because its next step
    // relaunches the client under a debugger. While it owns an install, the app
    // starts nothing; the next check starts the client once the install is done.
    if (!this.job && this.runtime.installInFlight) return this.status();
    if (!this.job) {
      this.error = undefined;
      const done = work()
        .catch((error: unknown) => {
          this.error = error instanceof Error ? error.message : String(error);
          log.warn("wechat_app.failed", { kind, error: this.error });
        })
        .finally(() => {
          this.job = null;
        });
      this.job = { kind, done };
    }
    return this.status();
  }
}

export class WechatAppNotInstalled extends Error {
  constructor() {
    super("WeChat is not installed.");
    this.name = "WechatAppNotInstalled";
  }
}
