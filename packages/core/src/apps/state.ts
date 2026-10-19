import type { AppViewState } from "@rome/api-types/apps";
import type { AppEntry, AppError, SpecSource } from "./lockfile.js";
import type {
  RomeAppManifest,
  ResolvedRomeAppApiMetadata,
  ResolvedRomeAppDbMetadata,
  ResolvedRomeAppWebMetadata,
} from "./types.js";

export type AppId = string;

export type ArtifactKind = "agent" | "action" | "skill" | "hook";

export interface ArtifactRef {
  formatVersion?: 1 | 2;
  kind: ArtifactKind;
  publicName: string;
  aliases: readonly string[];
  ownerType: "core" | "app";
  ownerId: string;
  absolutePath: string;
}

export type { AppViewState };

/** Runtime view: lockfile entry + in-flight overlay. */
export interface AppView extends Omit<AppEntry, "state"> {
  appId: AppId;
  state: AppViewState;
  /**
   * Display metadata resolved from the installed bundle's manifest. Present on
   * every ResolvedApp, and also attached to installed-but-disabled views so
   * surfaces can show the real name/icon without the app being loaded. Never
   * use these to decide whether an app is runnable — that's `isResolvedApp`.
   */
  displayName?: string;
  iconAbsolutePath?: string;
  /** Passive manifest metadata. Never use this to decide whether the app can run. */
  includeSource?: boolean;
}

export interface ResolvedArtifacts {
  agent: readonly ArtifactRef[];
  action: readonly ArtifactRef[];
  skill: readonly ArtifactRef[];
  hook: readonly ArtifactRef[];
}

/** Fully resolved app: present only when `state === "installed"` and resolve succeeded. */
export interface ResolvedApp extends AppView {
  manifest: RomeAppManifest;
  /** Absolute path to the active bundle root (the directory the `active` symlink resolves to). */
  rootPath: string;
  /** Effective base for resolving artifact paths (rootPath + manifest.appRoot). */
  resolveRoot: string;
  /** Human-readable name (manifest.name ?? manifest.id) computed at resolve. */
  displayName: string;
  /** Absolute path to manifest.icon if present. */
  iconAbsolutePath: string | undefined;
  artifacts: ResolvedArtifacts;
  web: ResolvedRomeAppWebMetadata | null;
  api: ResolvedRomeAppApiMetadata | null;
  db: ResolvedRomeAppDbMetadata | null;
}

/** Unresolved views (installing, broken, disabled) carry no `manifest`. */
export function isResolvedApp(view: AppView | null | undefined): view is ResolvedApp {
  return view != null && "manifest" in view;
}

export interface InFlightOp {
  kind: "install" | "uninstall";
  source?: SpecSource;
  startedAt: string;
}

export type CatalogChange = "added" | "changed" | "removed";

export interface CatalogEvent {
  appId: AppId;
  change: CatalogChange;
  /** `null` iff `change === "removed"`. */
  current: AppView | ResolvedApp | null;
}

export type SubscriberHandler = (event: CatalogEvent) => Promise<void> | void;
export type Unsubscribe = () => void;

/** Marker type re-export so callers don't dual-import. */
export type { AppEntry, AppError, SpecSource };
