import type { Channel, ChannelMessageHookDeps } from "@rome-os/app-runtime";
import { Mutex } from "async-mutex";
import type { AppCatalog } from "../apps/catalog.js";
import type { ChannelMessageHook } from "../apps/hooks/types.js";
import type { ArtifactRef } from "../apps/state.js";
import { createLogger, type Logger } from "../logger.js";
import { createChannelMessageHook } from "./app-actions-wiring.js";
import type { WakeGateFor } from "../participation/wake-gate/index.js";

const log = createLogger("channel-message-hooks");

const HOOK_NAME = "channel-message";

export interface ChannelMessageHooksOptions {
  catalog: Pick<AppCatalog, "listArtifacts">;
  /** What every app's hook is created with. */
  /** The SDK's hook deps, and the wake gate the SDK does not describe yet. */
  deps: ChannelMessageHookDeps & { wakeGateFor: WakeGateFor };
  /** Whether an app's hook may load now. Absent, every app's may. */
  mayLoad?: (appId: string) => boolean;
  /** An app's hook failed to load or to register, and is not live. */
  onFailed: (appId: string, error: string) => void;
  /** An app's hook loaded and registered. */
  onLoaded?: (appId: string) => void;
  /** An app's hook is about to be brought in line with the catalog again, so
   *  a failure reported for it earlier no longer stands. */
  onReset?: (appId: string) => void;
  log?: Pick<Logger, "warn">;
}

/**
 * The `channel-message` hooks of every app that declares one, each created
 * with the same deps and registered on its own. One app's hook failing to load
 * or to register leaves the others live, and a change to one app reaches only
 * that app's hook. Every change runs one at a time, so a reload and a catalog
 * change to the same app never both register a hook for it.
 */
export class ChannelMessageHooks {
  /** The live hooks, by the id of the app that declares each. */
  private readonly live = new Map<string, ChannelMessageHook>();
  private readonly changes = new Mutex();
  private readonly log: Pick<Logger, "warn">;

  constructor(private readonly options: ChannelMessageHooksOptions) {
    this.log = options.log ?? log;
  }

  /** How many hooks are live. */
  get size(): number {
    return this.live.size;
  }

  /** Load and register the hook of every app that declares one. */
  start(): Promise<void> {
    return this.changes.runExclusive(() => this.openMissing());
  }

  /**
   * Bring one app's hook in line with the catalog after the app was
   * installed, removed, enabled, disabled or reinstalled: its old hook stops
   * hearing, and the one it declares now, if any, starts. A live hook without
   * `unregister()` cannot stop hearing, so it is kept rather than doubled.
   */
  follow(appId: string): Promise<void> {
    return this.changes.runExclusive(() => this.followNow(appId));
  }

  private async followNow(appId: string): Promise<void> {
    this.options.onReset?.(appId);
    const previous = this.live.get(appId);
    if (previous && !previous.unregister) {
      this.log.warn("channel-message hook has no unregister(); keeping it until restart", {
        appId,
      });
      return;
    }
    if (previous) {
      this.live.delete(appId);
      previous.unregister?.();
    }
    const artifact = this.artifacts().find((each) => each.ownerId === appId);
    if (artifact) await this.open(artifact);
  }

  /**
   * Create every live hook again, as after an app-keys change, so a value its
   * module captured from the environment follows the change. Each app's swap
   * stands alone: the old hook detaches before the new one registers, and a
   * new hook that fails to register gives way to the old one again. A hook
   * without `unregister()` is left in place, stale but single. A hook that
   * is not live, as one that failed for want of a key, is tried again.
   */
  reload(): Promise<void> {
    return this.changes.runExclusive(() => this.reloadNow());
  }

  private async reloadNow(): Promise<void> {
    const artifacts = new Map(this.artifacts().map((each) => [each.ownerId, each]));
    for (const [appId, previous] of [...this.live]) {
      const artifact = artifacts.get(appId);
      if (!artifact) continue;
      if (!previous.unregister) {
        this.log.warn("channel-message hook has no unregister(); keeping the current instance", {
          appId,
        });
        continue;
      }
      let fresh: ChannelMessageHook;
      try {
        fresh = await createChannelMessageHook(artifact, this.options.deps, this.log);
      } catch (err) {
        this.log.warn("channel-message hook reload failed; keeping the previous instance", {
          appId,
          error: message(err),
        });
        continue;
      }
      previous.unregister();
      try {
        await fresh.register();
        this.live.set(appId, fresh);
      } catch (err) {
        this.log.warn("reloaded channel-message hook failed to register; restoring the previous", {
          appId,
          error: message(err),
        });
        await previous.register();
      }
    }
    await this.openMissing();
  }

  /**
   * Have every live hook hear `added`, channels the host just appended to the
   * deps' `channels`. A hook without `addChannels` registers again, which
   * drops events still waiting on its other subscriptions; a hook with
   * neither hears them from the next restart.
   */
  addChannels(added: readonly Channel[]): Promise<void> {
    return this.changes.runExclusive(() => this.addChannelsNow(added));
  }

  private async addChannelsNow(added: readonly Channel[]): Promise<void> {
    for (const [appId, hook] of this.live) {
      try {
        if (hook.addChannels) {
          await hook.addChannels(added);
        } else if (hook.unregister) {
          hook.unregister();
          await hook.register();
        } else {
          this.log.warn("channel-message hook can neither add channels nor unregister", {
            appId,
            channels: added.map((channel) => channel.name),
          });
        }
      } catch (err) {
        this.log.warn("channel-message hook did not subscribe to a later channel", {
          appId,
          channels: added.map((channel) => channel.name),
          error: message(err),
        });
      }
    }
  }

  /** Load and register each hook that may load and is not live. */
  private async openMissing(): Promise<void> {
    for (const artifact of this.artifacts()) {
      if (!this.live.has(artifact.ownerId)) await this.open(artifact);
    }
  }

  /** Each app's `channel-message` hook that may load now. */
  private artifacts(): ArtifactRef[] {
    return this.options.catalog
      .listArtifacts("hook")
      .filter(
        (artifact) =>
          artifact.publicName === HOOK_NAME && (this.options.mayLoad?.(artifact.ownerId) ?? true),
      );
  }

  private async open(artifact: ArtifactRef): Promise<void> {
    let hook: ChannelMessageHook | undefined;
    try {
      hook = await createChannelMessageHook(artifact, this.options.deps, this.log);
      await hook.register();
      this.live.set(artifact.ownerId, hook);
      this.options.onLoaded?.(artifact.ownerId);
    } catch (err) {
      // Whatever it subscribed before it threw stops hearing.
      hook?.unregister?.();
      this.log.warn("channel-message hook failed to initialize", {
        appId: artifact.ownerId,
        error: message(err),
      });
      this.options.onFailed(artifact.ownerId, message(err));
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
