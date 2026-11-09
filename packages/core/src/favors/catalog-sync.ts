import type { AppCatalog } from "../apps/catalog.js";
import { type AppId, isResolvedApp, type ResolvedApp } from "../apps/state.js";
import type { Action } from "../apps/actions/types.js";
import type { ArtifactMetadata } from "../apps/types.js";
import type { Logger } from "../logger.js";
import type { FavorService } from "./types.js";
import { favorAppIdentity } from "./rome-cloud-service.js";
import type { FavorRequiredActionDefinition } from "@rome-os/app-runtime";

interface ActionCatalogForFavorSync {
  list(): string[];
  get(name: string): Action | undefined;
  getMetadata(name: string): ArtifactMetadata | undefined;
}

export function favorActionRequirementsForApp(
  app: ResolvedApp,
  actionCatalog: ActionCatalogForFavorSync,
): FavorRequiredActionDefinition[] {
  const definitions: FavorRequiredActionDefinition[] = [];
  for (const actionName of actionCatalog.list().sort()) {
    const action = actionCatalog.get(actionName);
    const metadata = actionCatalog.getMetadata(actionName);
    if (!action || !metadata) continue;
    if (metadata.ownerType !== "app" || metadata.ownerId !== app.appId) continue;

    const requirement = action.config.favorRequirement;
    if (!requirement) continue;
    if (!action.inputSchema) {
      throw new Error(`Favor-required action "${action.config.name}" must expose inputSchema`);
    }

    definitions.push({
      actionName: action.config.name,
      amount: requirement.amount,
      title: requirement.title,
      summary: requirement.summary,
      argsSchema: action.inputSchema,
      displayFields: requirement.displayFields ?? [],
    });
  }
  return definitions;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Keeps Rome Cloud's favor requirements in step with the app catalog.
 *
 * Syncs of one app run in order, and each reads the app's catalog state when it
 * starts rather than when it was requested, so an app's last sync always sends
 * its current definitions. Syncs of different apps run in parallel up to
 * `concurrency`. A failed sync is logged at debug and dropped: the next boot or
 * catalog change for the app sends again.
 */
export class FavorRequirementSync {
  private readonly favorService: FavorService;
  private readonly appCatalog: Pick<AppCatalog, "get" | "listResolved">;
  private readonly actionCatalog: ActionCatalogForFavorSync;
  private readonly log: Logger;
  private readonly concurrency: number;
  private readonly tails = new Map<AppId, Promise<void>>();
  private readonly queued = new Map<AppId, Promise<void>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: {
    favorService: FavorService;
    appCatalog: Pick<AppCatalog, "get" | "listResolved">;
    actionCatalog: ActionCatalogForFavorSync;
    log: Logger;
    concurrency?: number;
  }) {
    this.favorService = opts.favorService;
    this.appCatalog = opts.appCatalog;
    this.actionCatalog = opts.actionCatalog;
    this.log = opts.log;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /**
   * Resolves once a sync that read the app's state no earlier than this call
   * has finished. Never rejects. Calls for an app whose sync has not started
   * yet share that sync.
   */
  sync(appId: AppId): Promise<void> {
    const waiting = this.queued.get(appId);
    if (waiting) return waiting;
    const tail = this.tails.get(appId) ?? Promise.resolve();
    const next = tail.then(() => this.send(appId));
    this.queued.set(appId, next);
    this.tails.set(appId, next);
    void next.then(() => {
      if (this.tails.get(appId) === next) this.tails.delete(appId);
    });
    return next;
  }

  /** Syncs every resolved app. Resolves when all have finished. Never rejects. */
  async syncAll(): Promise<void> {
    await Promise.all(this.appCatalog.listResolved().map((app) => this.sync(app.appId)));
  }

  private async send(appId: AppId): Promise<void> {
    await this.acquire();
    // The state read happens after the slot is held, so a sync() call that
    // arrived while this one waited is covered by what it reads now.
    this.queued.delete(appId);
    try {
      const app = this.appCatalog.get(appId);
      await this.favorService.syncActionRequirements(
        isResolvedApp(app)
          ? {
              appId,
              requesterAppIdentity: favorAppIdentity(app),
              definitions: favorActionRequirementsForApp(app, this.actionCatalog),
            }
          : {
              appId,
              requesterAppIdentity: { appId, state: app?.state ?? "removed" },
              definitions: [],
            },
      );
    } catch (err) {
      this.log.debug("favor action-requirement sync skipped", {
        appId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    // release() hands its slot straight to the waiter, so active stays counted.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}
