import { Mutex } from "async-mutex";
import { createLogger } from "../logger.js";
import type { AppEntry } from "./lockfile.js";
import type { AppInstaller } from "./installer.js";
import type {
  AppId,
  AppView,
  ArtifactKind,
  ArtifactRef,
  CatalogChange,
  CatalogEvent,
  InFlightOp,
  ResolvedApp,
  SubscriberHandler,
  Unsubscribe,
} from "./state.js";

const log = createLogger("app-catalog");

export interface ReadLockfileEntryFn {
  (appId: AppId): Promise<AppEntry | null>;
}

export interface InFlightLookupFn {
  (appId: AppId): InFlightOp | undefined;
}

export interface MarkBrokenFn {
  (appId: AppId, code: string, message: string): Promise<void>;
}

export interface AppCatalogOptions {
  installer: AppInstaller;
  readLockfileEntry: ReadLockfileEntryFn;
  getInFlight: InFlightLookupFn;
  /**
   * Invoked when `installer.resolve()` fails for an entry the lockfile claims
   * is `installed`. The catalog will store a broken-state view; this hook
   * lets the AppManager persist that state to the lockfile.
   */
  markBroken: MarkBrokenFn;
}

interface RegisteredSubscriber {
  name: string;
  handler: SubscriberHandler;
}

/**
 * AppCatalog: in-memory resolved view of all apps + ordered subscribers.
 * Reads (get/list/findArtifact) are lock-free; refresh is serialized.
 */
export class AppCatalog {
  private readonly installer: AppInstaller;
  private readonly readLockfileEntry: ReadLockfileEntryFn;
  private readonly getInFlight: InFlightLookupFn;
  private readonly markBroken: MarkBrokenFn;
  private readonly internalMap = new Map<AppId, AppView | ResolvedApp>();
  private readonly subscribers: RegisteredSubscriber[] = [];
  private readonly refreshMutex = new Mutex();

  constructor(opts: AppCatalogOptions) {
    this.installer = opts.installer;
    this.readLockfileEntry = opts.readLockfileEntry;
    this.getInFlight = opts.getInFlight;
    this.markBroken = opts.markBroken;
  }

  get(appId: AppId): AppView | ResolvedApp | null {
    return this.internalMap.get(appId) ?? null;
  }

  list(): readonly (AppView | ResolvedApp)[] {
    return Object.freeze([...this.internalMap.values()]);
  }

  listResolved(): readonly ResolvedApp[] {
    const out: ResolvedApp[] = [];
    for (const view of this.internalMap.values()) {
      if (isResolved(view) && view.state === "installed" && view.enabled) {
        out.push(view);
      }
    }
    return Object.freeze(out);
  }

  findArtifact(kind: ArtifactKind, name: string): ArtifactRef | null {
    for (const app of this.listResolved()) {
      const list = app.artifacts[kind];
      for (const ref of list) {
        if (ref.publicName === name) return ref;
        if (ref.aliases.includes(name)) return ref;
      }
    }
    return null;
  }

  listArtifacts(kind: ArtifactKind): readonly ArtifactRef[] {
    const out: ArtifactRef[] = [];
    for (const app of this.listResolved()) {
      out.push(...app.artifacts[kind]);
    }
    return Object.freeze(out);
  }

  subscribe(handler: SubscriberHandler): Unsubscribe {
    const name = handler.name || "anonymous";
    const entry: RegisteredSubscriber = { name, handler };
    this.subscribers.push(entry);
    return () => {
      const idx = this.subscribers.indexOf(entry);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  /**
   * Re-read entry + in-flight overlay, optionally resolve manifest, fire event.
   * Refresh calls are serialized in invocation order.
   */
  refresh(appId: AppId): Promise<void> {
    return this.refreshMutex.runExclusive(() => this.refreshInternal(appId));
  }

  private async refreshInternal(appId: AppId): Promise<void> {
    const entry = await this.readLockfileEntry(appId);
    const inFlight = this.getInFlight(appId);
    const wasPresent = this.internalMap.has(appId);

    if (entry == null && inFlight == null) {
      if (wasPresent) {
        this.internalMap.delete(appId);
        await this.fireEvent({ appId, change: "removed", current: null });
      }
      return;
    }

    const view = buildAppView(appId, entry, inFlight);

    if (view.state === "installed" && view.enabled) {
      const resolveResult = await this.installer.resolve(appId);
      if (resolveResult.ok) {
        const resolved: ResolvedApp = {
          ...view,
          state: "installed",
          manifest: resolveResult.manifest,
          rootPath: resolveResult.rootPath,
          resolveRoot: resolveResult.resolveRoot,
          displayName: resolveResult.displayName,
          iconAbsolutePath: resolveResult.iconAbsolutePath,
          includeSource: resolveResult.manifest.includeSource === true,
          artifacts: resolveResult.artifacts,
          web: resolveResult.web,
          api: resolveResult.api,
          db: resolveResult.db,
        };
        this.internalMap.set(appId, resolved);
        const change: CatalogChange = wasPresent ? "changed" : "added";
        await this.fireEvent({ appId, change, current: resolved });
        return;
      }
      const brokenView: AppView = {
        ...view,
        state: "broken",
        lastError: { code: "RESOLVE_FAILED", message: resolveResult.reason },
      };
      this.internalMap.set(appId, brokenView);
      const change: CatalogChange = wasPresent ? "changed" : "added";
      await this.fireEvent({ appId, change, current: brokenView });
      await this.markBroken(appId, "RESOLVE_FAILED", resolveResult.reason);
      return;
    }

    if (view.state === "installed") {
      // Installed but disabled: keep the bare AppView (no `manifest`, so every
      // isResolvedApp guard stays false and nothing loads), but attach display
      // metadata without inspecting runtime artifacts. Metadata failures are
      // tolerated — a disabled app's integrity isn't asserted until re-enable.
      const metadataResult = await this.installer.resolveDisplayMetadata(appId);
      if (metadataResult.ok) {
        view.displayName = metadataResult.displayName;
        view.iconAbsolutePath = metadataResult.iconAbsolutePath;
        view.includeSource = metadataResult.includeSource;
      }
    }

    this.internalMap.set(appId, view);
    const change: CatalogChange = wasPresent ? "changed" : "added";
    await this.fireEvent({ appId, change, current: view });
  }

  private async fireEvent(event: CatalogEvent): Promise<void> {
    for (const subscriber of this.subscribers) {
      try {
        await subscriber.handler(event);
      } catch (err) {
        log.error("subscriber failed", {
          subscriber: subscriber.name,
          appId: event.appId,
          change: event.change,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function buildAppView(
  appId: AppId,
  entry: AppEntry | null,
  inFlight: InFlightOp | undefined,
): AppView {
  if (inFlight != null && entry == null) {
    return {
      appId,
      source: inFlight.source ?? { mode: "bundle", path: "<UNKNOWN>" },
      enabled: true,
      firstParty: false,
      state: inFlight.kind === "install" ? "installing" : "uninstalling",
      installedHash: null,
      installedVersion: null,
      lastError: null,
      updatedAt: inFlight.startedAt,
    };
  }
  if (entry == null) {
    throw new Error(`buildAppView called with neither entry nor in-flight op for "${appId}"`);
  }
  if (inFlight != null) {
    return {
      appId,
      source: inFlight.source ?? entry.source,
      enabled: entry.enabled,
      firstParty: entry.firstParty,
      state: inFlight.kind === "install" ? "installing" : "uninstalling",
      installedHash: entry.installedHash,
      installedVersion: entry.installedVersion,
      installedAt: entry.installedAt,
      lastError: entry.lastError,
      updatedAt: inFlight.startedAt,
    };
  }
  return {
    appId,
    source: entry.source,
    enabled: entry.enabled,
    firstParty: entry.firstParty,
    state: entry.state,
    installedHash: entry.installedHash,
    installedVersion: entry.installedVersion,
    installedAt: entry.installedAt,
    lastError: entry.lastError,
    updatedAt: entry.updatedAt,
  };
}

function isResolved(view: AppView | ResolvedApp): view is ResolvedApp {
  return (view as ResolvedApp).manifest !== undefined;
}
