import { z } from "zod";

// Shared app lifecycle wire contracts. App lifecycle: docs/architecture/app-lifecycle.md.

/**
 * Installs from an editable workspace. The daemon builds it, packs it into
 * `<path>/.rome/artifact`, and installs the artifact.
 */
export const SourceDirSourceSchema = z.object({
  mode: z.literal("source"),
  path: z.string().min(1),
});

/**
 * Installs a packed artifact as-is. The path must not point to a source
 * workspace; the daemon does not build, snapshot, or select an `appRoot`.
 */
export const BundleSourceSchema = z.object({
  mode: z.literal("bundle"),
  path: z.string().min(1),
});

export const AppstoreSourceSchema = z.object({
  mode: z.literal("appstore"),
  listingId: z.string().min(1),
  version: z.string().min(1),
  /** May be omitted on the first fetch; the daemon resolves and pins the authoritative digest. */
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "contentHash must be 64-char hex sha256")
    .optional(),
});

export const SpecSourceSchema = z.discriminatedUnion("mode", [
  SourceDirSourceSchema,
  BundleSourceSchema,
  AppstoreSourceSchema,
]);

export type SourceDirSource = z.infer<typeof SourceDirSourceSchema>;
export type BundleSource = z.infer<typeof BundleSourceSchema>;
export type AppstoreSource = z.infer<typeof AppstoreSourceSchema>;
export type SpecSource = z.infer<typeof SpecSourceSchema>;

/** A Store intent identifies an exact version, never a moving latest release. */
export type AppRemixStoreIntent = {
  listingId: string;
  version: string;
};

export type AppRemixStorePin = AppRemixStoreIntent & {
  contentHash: string;
};

export type AppRemixSource =
  | { appId: string; expectedSource?: AppRemixStorePin }
  | AppRemixStorePin;

export const PERSISTED_APP_STATES = ["installed", "failed", "broken"] as const;
export type PersistedAppState = (typeof PERSISTED_APP_STATES)[number];

export const APP_VIEW_STATES = [...PERSISTED_APP_STATES, "installing", "uninstalling"] as const;
export type AppViewState = (typeof APP_VIEW_STATES)[number];

export type RomeAppRuntimeStatus = "active" | "disabled" | "failed";
export type AppAccessMode = "private" | "public" | "cloud-email";

/** Provenance only; callers must use the capability fields for authorization. */
export type AppOrigin = "builtin" | "appstore" | "local";

export interface AppArtifactSummary {
  name: string;
  description: string;
  /** Diagnostic for a declared artifact that failed to load. Consumers must surface it. */
  loadError?: string;
}

export interface AppArtifactDetails {
  agents: AppArtifactSummary[];
  actions: AppArtifactSummary[];
  skills: AppArtifactSummary[];
  hooks: AppArtifactSummary[];
}

/** Non-binding routing hint from an app manifest. Channel contract: docs/architecture/channels.md. */
export interface SuggestedChannelBinding {
  channel: "discord" | "telegram" | "whatsapp" | "wechat" | "webchat" | "feishu";
  agent: string;
  reason?: string;
}

export interface AppSpec {
  source: SpecSource;
  enabled: boolean;
}

export interface InstalledAppCard {
  id: string;
  version: string;
  description: string;
  displayName: string;
  status: RomeAppRuntimeStatus;
  phase: AppViewState;
  error?: string;
  hasFrontend: boolean;
  href: string | null;
  fullHref: string | null;
  capabilities: string[];
  capabilityDetails: AppArtifactDetails;
  isEnabled: boolean;
  canToggle: boolean;
  canUninstall: boolean;
  /** Projection of the installed app.yaml flag. Missing means false. */
  includeSource?: boolean;
  /** UI capability hint only; the publish endpoint still enforces store policy. */
  canPublish: boolean;
  accessMode: AppAccessMode;
  isPublic: boolean;
  cloudAllowedEmails: string[];
  canManagePublicAccess: boolean;
  /** Authoritative installed source, suitable for a re-install or upgrade request. */
  source: SpecSource;
  /**
   * Project-root-relative path of the app's editable source workspace. This is
   * present only when the installed source is a workspace inside Rome's
   * projects tree, and can be passed directly to the new-chat flow.
   */
  projectPath: string | null;
  origin: AppOrigin;
  /**
   * When the app first installed, ISO-8601. `null` for installs that predate
   * the field. Optional on the wire; consumers must default to `null`.
   */
  installedAt?: string | null;
  /** Root-relative icon URL, or `null` when the manifest declares no icon. */
  iconUrl: string | null;
  /** Optional on the wire; consumers must default to `[]`. */
  suggestedChannelBindings?: SuggestedChannelBinding[];
}

export interface AppListResponse {
  apps: InstalledAppCard[];
}

/**
 * Returns the packed root README. `readme` is `null` when it is absent or the
 * installed app is unresolved; an unknown app is an error.
 */
export interface AppReadmeResponse {
  appId: string;
  readme: string | null;
}

export interface AppDetailResponse {
  spec: AppSpec;
  phase: AppViewState;
  error?: string;
}

export interface AppInstallResponse extends AppDetailResponse {
  appId: string;
}

/**
 * Successful App Store publish result. `claimed` reports whether this request
 * claimed the listing handle for the account.
 */
export interface AppPublishResponse {
  appId: string;
  listing: { id: string; handle: string; slug: string };
  version: {
    version: string;
    contentHash: string;
    sizeBytes: number;
    sourceAvailable: boolean;
  };
  claimed: boolean;
}
