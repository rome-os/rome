import type { OAuthProvider } from "../connections/oauth/oauth-providers.js";

/**
 * Source-agnostic sync abstraction.
 *
 * The whole feature turns on this one interface. Core, the DB, the API routes,
 * and the two web components only ever speak `SyncSource` — they must not know
 * about git, GitHub, branches or commits. GitHub/Git is merely the first
 * implementation; a future Google Drive source is a new file + one registry
 * line, with no change to anything below.
 */

export type SyncSourceId = string; // "git" (first), later "gdrive", ...

/** A remote target a project can sync against (a repo, a cloud folder, …). The
 * `locator` is opaque to core — only the owning source interprets it. */
export interface RemoteTarget {
  sourceId: SyncSourceId;
  locator: Record<string, unknown>;
  label: string;
}

/** A candidate shown in the "pick an existing target" step of the connect UI. */
export interface RemoteTargetCandidate extends RemoteTarget {
  description?: string;
  /** The owning group/namespace (git: repo owner login). Lets the UI group and
   * filter candidates by group. */
  group?: string;
  /** Whether the remote already has content — informs which reconciliation
   * case the link will fall into. `undefined` = unknown until link. */
  isEmpty?: boolean;
}

/** A namespace a new target can be created under (git: the user's account + any
 * orgs they belong to). Source-agnostic so a cloud source can expose shared
 * drives, etc. */
export interface SyncGroup {
  id: string;
  label: string;
  icon?: string;
}

/** The single generic shape the status component consumes. No git-specific
 * fields: git fills `ref` with a branch, another source with a revision. */
export interface SyncStatus {
  state: "unlinked" | "linked" | "syncing" | "ahead" | "behind" | "diverged" | "conflict" | "error";
  ref?: string;
  /** The source's primary ref. When a clean project is on another ref, the UI
   * can offer to return to this one. */
  defaultRef?: string;
  remoteLabel?: string;
  /** Browser-openable URL for the remote target, when the source can expose one. */
  remoteUrl?: string;
  /** The bound source's id (e.g. "git"), so the UI can pick the right logo.
   * Filled by the route from the persisted link, not by the source itself. */
  sourceId?: string;
  /** Whether the remote target is private. A persisted target attribute (set at
   * link time), surfaced for display — generic across sources (repos, drives). */
  private?: boolean;
  changes?: { added: number; modified: number; removed: number };
  ahead?: number;
  behind?: number;
  lastSyncedAt?: string;
  message?: string;
}

/** A single file that differs from the synced baseline. Source-agnostic: git
 * fills it from `git status`, another source from whatever diff it computes. The
 * `change` buckets line up with the three `SyncStatus.changes` counters so the
 * list and the summary always agree. */
export interface ChangedFile {
  /** Path relative to the project root (git: the working-tree path; renames
   * report the destination). */
  path: string;
  change: "added" | "modified" | "removed";
}

/** A source-native textual representation of one local change. Git sources
 * return a unified patch; other sources can expose the same UI-ready format. */
export interface ChangeDiff {
  path: string;
  patch: string;
  /** True when the source capped a very large patch before returning it. */
  truncated?: boolean;
}

export type LinkStrategy = "auto" | "pull-remote" | "push-local" | "merge";

export type ResolvedCase = "empty-empty" | "empty-remote" | "local-empty" | "local-remote";

/**
 * Opaque per-link payload persisted in `project_sync_links.project_link_extra`.
 * Each source defines and validates its own shape; core never inspects it. Holds
 * the target identity (to relocate it / recover if the native store is lost),
 * the user's creation-time inputs, and small source-owned caches (e.g. a remote
 * fact with no local SSOT). The source's own native store (for git, `.git` +
 * the remote) remains the source of truth for everything operational.
 */
export type LinkExtra = Record<string, unknown>;

export interface LinkOutcome {
  status: SyncStatus;
  /** The payload to persist for this link (built by the source). */
  extra: LinkExtra;
  resolvedCase: ResolvedCase;
}

export interface SyncOutcome {
  status: SyncStatus;
  /** Possibly-updated payload to persist (e.g. refreshed visibility / sync time). */
  extra: LinkExtra;
}

export interface SyncAvailability {
  available: boolean;
  reason?: string;
  connectUrl?: string;
}

export interface SyncSource {
  readonly id: SyncSourceId;
  readonly label: string;
  readonly icon?: string;
  /** Which OAuth provider this source authenticates through, if any. Lets the
   * route compute a `connectUrl` generically without knowing about the source. */
  readonly authProvider?: OAuthProvider;

  availability(): Promise<SyncAvailability>;
  /** Namespaces a new target can be created under. Optional: sources without a
   * group concept omit it and the UI hides the selector. */
  listGroups?(): Promise<SyncGroup[]>;
  listTargets(query?: string): Promise<RemoteTargetCandidate[]>;
  createTarget(spec: {
    name: string;
    group?: string;
    private?: boolean;
    description?: string;
  }): Promise<RemoteTarget>;
  link(projectDir: string, target: RemoteTarget, strategy: LinkStrategy): Promise<LinkOutcome>;
  unlink(projectDir: string): Promise<void>;
  /** `extra` is the persisted link payload. Sources with an on-disk native store
   * (git) mostly ignore it; sources without one (e.g. a cloud folder) need it to
   * know which remote target this project points at. */
  status(projectDir: string, extra: LinkExtra): Promise<SyncStatus>;
  /** Enumerate the individual files behind `status().changes` (the local-vs-baseline
   * diff). Optional: a source that can't cheaply list them omits it, and the UI
   * hides the drill-down. Read-only — never mutates the working tree. */
  listChanges?(projectDir: string, extra: LinkExtra): Promise<ChangedFile[]>;
  /** Return the actual local-vs-baseline patch for one changed path. Optional
   * because not every sync source has a textual diff representation. */
  getChangeDiff?(projectDir: string, path: string, extra: LinkExtra): Promise<ChangeDiff>;
  /** Discard the local change for one path and restore the synced baseline.
   * Optional for sources that cannot restore individual files. */
  restoreChange?(projectDir: string, path: string, extra: LinkExtra): Promise<void>;
  /** Discard every local change and restore the synced baseline. Optional for
   * sources that cannot restore their whole local change set. */
  restoreAllChanges?(projectDir: string, extra: LinkExtra): Promise<void>;
  /** Return a clean local source to its primary ref. Optional for sources that
   * do not expose ref switching. */
  resetToDefault?(projectDir: string, extra: LinkExtra): Promise<SyncStatus>;
  sync(
    projectDir: string,
    direction: "push" | "pull" | "both",
    extra: LinkExtra,
  ): Promise<SyncOutcome>;
}

/** Persisted descriptor of a source (no instance) for the connect UI's first step. */
export interface SyncSourceDescriptor {
  id: SyncSourceId;
  label: string;
  icon?: string;
  authProvider?: OAuthProvider;
}
