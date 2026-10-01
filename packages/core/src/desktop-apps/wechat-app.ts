// The WeChat app: the desktop client on WeChat's own desktop, which the guardian
// installs and opens from /desktop/wechat. Independent of the WeChat connection
// (connections/integrations/wechat-user.ts): the app runs without one, and a
// connection reads the same client when the guardian adds it.

import type { WechatAppState } from "@rome/api-types/wechat-app";
import type { WechatUserRuntime } from "../channels/wechat-user.js";
import { createLogger } from "../logger.js";

const log = createLogger("wechat-app");

/** The app's state on an instance with WeChat enabled. */
export interface WechatAppStatus {
  state: Exclude<WechatAppState, "unavailable">;
  error?: string;
}

export type WechatAppRuntime = Pick<WechatUserRuntime, "installed" | "install" | "start" | "pid">;

/**
 * Installs and starts the WeChat client on demand. Both run in the background,
 * because a download takes minutes, and the page polls `status()`. One runs at
 * a time: a second request while one runs joins it.
 */
export class WechatApp {
  private job: { kind: "installing" | "starting"; done: Promise<void> } | null = null;
  private error: string | undefined;

  constructor(private readonly runtime: WechatAppRuntime) {}

  async status(): Promise<WechatAppStatus> {
    const error = this.error ? { error: this.error } : {};
    if (this.job) return { state: this.job.kind };
    if (!(await this.runtime.installed())) return { state: "absent", ...error };
    if (!(await this.runtime.pid())) return { state: "stopped", ...error };
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
    if (!this.job && !(await this.runtime.installed())) {
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
