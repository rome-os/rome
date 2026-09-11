export type ArtifactOwnerType = "core" | "app";
export type RomeAppArtifactKind = "agent" | "action" | "skill" | "hook";
export type RomeAppRoutingMode = "client";

export interface ArtifactOwnership {
  ownerType: ArtifactOwnerType;
  ownerId: string;
}

export interface ArtifactMetadata extends ArtifactOwnership {
  formatVersion?: 1 | 2;
  kind: RomeAppArtifactKind;
  publicName: string;
  aliases: string[];
  sourcePath: string;
}

export interface RomeAppArtifactEntry {
  path: string;
  publicName?: string;
  aliases?: string[];
  legacyPath?: string;
}

export interface RomeAppWebDeclaration {
  manifest: string;
}

export interface RomeAppApiDeclaration {
  entry?: string;
  /**
   * Controls whether requests to `/api/app-api/<appId>/*` bypass the
   * dashboard session check. Intended for endpoints reachable from the
   * public internet (third-party callbacks, public webhooks).
   *
   * - `true` — all sub-paths under the app bypass the session check.
   * - `string[]` — only the listed sub-paths bypass the session check.
   *   Each entry is a path relative to `/api/app-api/<appId>` and must
   *   start with `/`. A trailing `/*` segment turns the entry into a
   *   prefix match (e.g. `/webhooks/*` matches `/webhooks/stripe/event`);
   *   otherwise the sub-path must match exactly.
   * - `false`/unset — every request requires a session cookie.
   *
   * The dashboard-side `/api/apps/<appId>/*` path is intentionally
   * unaffected and always requires a session.
   */
  noAuth?: boolean | string[];
  /**
   * Declares that this app consumes webhooks delivered by the core webhook
   * relay drainer. The value is the app-api sub-path the drained webhook is
   * delivered to (e.g. `"webhook"` → the handler's `["webhook"]` path).
   *
   * Core resolves the relay's delivery target from this declaration instead of
   * naming an app, so the relay stays app-neutral. The binding comes from the
   * installed manifest (trusted config), never the untrusted per-event frame —
   * a depositor cannot redirect delivery to another app.
   */
  relayWebhook?: string;
}

export interface RomeAppDbDeclaration {
  migrations: string;
  tablePrefix?: string;
}

export interface RomeAppBuildManifest {
  entry: string;
  styles: string[];
  assetVersion: string;
  displayName: string;
  navLabel?: string;
  routing: RomeAppRoutingMode;
}

export interface ResolvedRomeAppWebMetadata extends RomeAppBuildManifest {
  appId: string;
  version: string;
  assetVersion: string;
  manifestPath: string;
  distPath: string;
}

export interface ResolvedRomeAppApiMetadata {
  appId: string;
  entryPath: string;
  /**
   * Resolved from `RomeAppApiDeclaration.noAuth`, defaulting to `false`
   * when the manifest omits the field. The `/api/app-api` dispatcher
   * reads this directly to decide whether to bypass session auth.
   */
  noAuth: boolean | string[];
  /**
   * App-api sub-path that the relay drainer delivers drained webhooks to,
   * or `null` when the app declares no `api.relayWebhook`. Core scans this
   * across installed apps to resolve the relay's (app-neutral) target.
   */
  relayWebhook: string | null;
}

export interface ResolvedRomeAppDbMetadata {
  appId: string;
  migrationsPath: string;
  migrationsTable: string;
  tablePrefix: string;
}

/**
 * Hint declared by an app for how a guardian could route a channel directly
 * to one of the agents this app ships. Non-binding: nothing is auto-wired —
 * dashboard UI / setup flows surface these as a one-click suggestion ("Route
 * a Discord channel to `pm-assistant`?"). The guardian still picks the actual
 * channel.
 */
export interface RomeAppSuggestedChannelBinding {
  /** Channel platform the suggestion applies to (e.g. "discord"). */
  channel: "discord" | "telegram" | "whatsapp" | "wechat" | "webchat" | "feishu";
  /** Name of the agent (must match a `publicName` in this app's `agents`). */
  agent: string;
  /** Optional human-readable reason shown next to the suggestion. */
  reason?: string;
}

export interface RomeAppManifest {
  formatVersion?: 1 | 2;
  id: string;
  version: string;
  description: string;
  /**
   * One-line, author-written hook for the app's social share card. Falls
   * back to the first sentence of `description` when absent.
   */
  tagline?: string;
  /** Human-readable App name. Consumed by both Rome Cloud and Rome. */
  name?: string;
  /** Path relative to appRoot to an icon asset (svg/png/webp). */
  icon?: string;
  appRoot?: string;
  /** Local source-availability signal copied from app.yaml. */
  includeSource?: boolean;
  /** Store version this app was remixed from, when present. */
  remix?: { listing: string; version: string };
  agents: RomeAppArtifactEntry[];
  actions: RomeAppArtifactEntry[];
  skills: RomeAppArtifactEntry[];
  hooks: RomeAppArtifactEntry[];
  /** Inline component ids the app's web bundle registers and may render in chat. */
  components?: string[];
  web?: RomeAppWebDeclaration;
  api?: RomeAppApiDeclaration;
  db?: RomeAppDbDeclaration;
  /**
   * Optional hints for "route channel X to agent Y". Surfaced by dashboard /
   * setup flows; guardians still confirm the binding manually. See
   * `RomeAppSuggestedChannelBinding`.
   */
  suggestedChannelBindings?: RomeAppSuggestedChannelBinding[];
}

export interface RomeAppDefinition extends RomeAppManifest {
  /** Directory containing app.yaml. */
  rootPath: string;
  /** Effective base for resolving artifact paths (rootPath + appRoot). */
  resolveRoot: string;
  /** Human-readable name (manifest.name ?? manifest.id) computed at load. */
  displayName: string;
  /** Absolute path to the app icon asset, when manifest.icon is present. */
  iconAbsolutePath?: string;
  resolvedWeb?: ResolvedRomeAppWebMetadata;
  resolvedApi?: ResolvedRomeAppApiMetadata;
  resolvedDb?: ResolvedRomeAppDbMetadata;
}

/**
 * @deprecated Replaced by `AppView` from `state.ts` under the imperative
 * apps domain. Kept as a type alias for code that
 * still references the legacy shape during the cutover window.
 */
export interface RomeAppCatalogEntry {
  id: string;
  enabled: boolean;
  version?: string;
  description?: string;
  rootPath?: string;
  app?: RomeAppDefinition;
  error?: string;
}

export interface AppOwnedArtifactLoadFailure {
  kind: RomeAppArtifactKind;
  ownerId: string;
  publicName: string;
  sourcePath: string;
  error: string;
}
