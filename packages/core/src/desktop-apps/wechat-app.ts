// The WeChat app: the desktop client on WeChat's own desktop, which the guardian
// installs and opens from /desktop/wechat. Independent of the WeChat connection
// (connections/integrations/wechat-user.ts): the app runs without one, and a
// connection reads the same client, and starts it itself when it is missing.

import type {
  WechatAppState,
  WechatAppStatus as WechatAppResponse,
} from "@rome/api-types/wechat-app";
import type { WechatUserRuntime } from "../channels/wechat-user.js";
import { createLogger } from "../logger.js";

const log = createLogger("wechat-app");

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
  | "clientDisplay"
  | "display"
>;

/**
 * Installs and starts the WeChat client on demand. The page starts an installed
 * client when the guardian opens it. Both run in the background, because a
 * download takes minutes, and the page polls `status()`. One runs at a time: a
 * second request while one runs joins it.
 */
export class WechatApp {
  private job: { kind: "installing" | "starting"; done: Promise<void> } | null = null;
  private error: string | undefined;

  constructor(private readonly runtime: WechatAppRuntime) {}

  async status(): Promise<WechatAppStatus> {
    if (this.job) return { state: this.job.kind };
    // The connection's setup installs through the same runtime. Reporting its
    // install keeps the page from offering a second one.
    if (this.runtime.installInFlight) return { state: "installing" };
    const error = this.error ? { error: this.error } : {};
    if (!(await this.runtime.installed())) return { state: "absent", ...error };
    const pid = await this.runtime.pid();
    if (!pid) {
      // The connection's setup owns the client until its key capture ends, and
      // the capture brings up WeChat's desktop and its own client. Until that
      // client runs, the app reports starting: the page must not start a client
      // of its own, and it reconnects its desktop view once the client runs.
      if (this.runtime.captureInProgress) return { state: "starting" };
      return { state: "stopped", ...error };
    }
    // This read clears the stored failure: a running client has overtaken the
    // attempt it described, whoever started it.
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
    return this.run("starting", () => this.runtime.start());
  }

  /** Resolves when no install or start is running. For tests. */
  async settled(): Promise<void> {
    await this.job?.done;
  }

  private async run(
    kind: "installing" | "starting",
    work: () => Promise<void>,
  ): Promise<WechatAppStatus> {
    // The connection's setup installs without starting, because it owns the
    // client until its key capture ends. While it owns an install, the app
    // starts nothing; the page shows the result once the install is done.
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
