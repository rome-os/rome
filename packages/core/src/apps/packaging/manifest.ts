import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { valid } from "semver";
import { z } from "zod";
import { isValidAppId } from "./app-id.js";
import {
  ArtifactLocalNameSchema,
  ArtifactLocalNameV2Schema,
  isValidArtifactReference,
} from "./artifact-name.js";

/** SQL identifier rule for `app.yaml#db.tablePrefix`; reused by manifest validation and the uninstall-purge primitive. */
export const TABLE_PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * The app.yaml format version this build understands. Store bundles are
 * immutable, so the schema is strict: a manifest is accepted only if every
 * field is recognized and `formatVersion` matches exactly. Incompatible
 * format changes bump this literal and teach the schema both shapes. Additive
 * optional fields require readers to deploy before publishers start using
 * them.
 */
export const APP_MANIFEST_FORMAT_VERSION = 2;
export const SUPPORTED_APP_MANIFEST_FORMAT_VERSIONS = [1, 2] as const;

export const ArtifactEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      publicName: z.string().min(1).optional(),
      aliases: z.array(z.string().min(1)).optional(),
      legacyPath: z.string().min(1).optional(),
    })
    .strict(),
]);

const NamespacedArtifactEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      publicName: ArtifactLocalNameSchema.optional(),
      aliases: z.array(ArtifactLocalNameSchema).optional(),
      legacyPath: z.string().min(1).optional(),
    })
    .strict(),
]);

const WebDeclarationSchema = z
  .object({
    manifest: z.string().min(1),
    displayName: z.string().min(1).optional(),
    navLabel: z.string().min(1).optional(),
    entry: z.string().min(1).optional(),
  })
  .strict();

const ApiDeclarationSchema = z
  .object({
    entry: z.string().min(1).optional(),
    noAuth: z
      .union([
        z.boolean(),
        z.array(z.string().min(1).startsWith("/", "noAuth path patterns must start with /")).min(1),
      ])
      .optional(),
    relayWebhook: z.string().min(1).optional(),
  })
  .strict();

const DbDeclarationSchema = z
  .object({
    migrations: z.string().min(1),
    tablePrefix: z.string().regex(TABLE_PREFIX_PATTERN).optional(),
  })
  .strict();

const SuggestedChannelBindingSchema = z
  .object({
    channel: z.enum(["discord", "telegram", "whatsapp", "wechat", "webchat", "feishu"]),
    agent: z.string().min(1),
    reason: z.string().min(1).optional(),
  })
  .strict();

const RemixDeclarationSchema = z
  .object({
    listing: z.string().min(1),
    version: z
      .string()
      .min(1)
      .refine((v) => valid(v) !== null, "must be a valid semver version"),
  })
  .strict();

export const AppManifestSchema = z
  .object({
    formatVersion: z.union([z.literal(1), z.literal(2)]),
    // The id becomes the lockfile key and artifact namespace, so it must
    // satisfy the shared app-id grammar (see app-id.ts).
    id: z
      .string()
      .min(1)
      .refine(
        isValidAppId,
        'must be an unscoped lowercase slug or a scoped App Store id such as "@handle/slug"',
      ),
    version: z
      .string()
      .min(1)
      .refine((v) => valid(v) !== null, "must be a valid semver version"),
    description: z.string().min(1),
    // One-line, author-written hook for the app's social share card
    // (≤ 80 width units — 80 Latin chars or 40 CJK — is the display rule; the
    // schema only caps length at 160 characters, the template truncates on
    // width). Card falls back to the first sentence of `description` when absent.
    tagline: z.string().min(1).max(160).optional(),
    name: z.string().min(1).optional(),
    icon: z.string().min(1).optional(),
    appRoot: z.string().min(1).optional(),
    includeSource: z.boolean().optional(),
    remix: RemixDeclarationSchema.optional(),
    // Basic store-listing metadata still lives in app.yaml because it is small
    // and useful for local display too. Rich store-page metadata and media live
    // in .rome_store/rome_store.yaml, which is published as a sidecar rather
    // than bundled into the installable runtime artifact.
    author: z.string().min(1).optional(),
    long_description: z.string().min(1).optional(),
    screenshots: z.array(z.string().min(1)).optional(),
    category: z.string().min(1).optional(),
    homepage: z.string().min(1).optional(),
    repository: z.string().min(1).optional(),
    agents: z.array(NamespacedArtifactEntrySchema).optional(),
    actions: z.array(NamespacedArtifactEntrySchema).optional(),
    skills: z.array(NamespacedArtifactEntrySchema).optional(),
    hooks: z.array(ArtifactEntrySchema).optional(),
    // Inline components the app's web bundle registers (via defineComponent) and
    // is allowed to render into the chat transcript. Core validates an action's
    // renderComponent.componentId against this list before mounting — an app
    // can only render components it declared here.
    components: z.array(z.string().min(1)).optional(),
    web: WebDeclarationSchema.optional(),
    api: ApiDeclarationSchema.optional(),
    db: DbDeclarationSchema.optional(),
    suggestedChannelBindings: z.array(SuggestedChannelBindingSchema).optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.id.startsWith("@") && manifest.db && !manifest.db.tablePrefix) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["db", "tablePrefix"],
        message: "is required for a scoped app id",
      });
    }
    if (manifest.formatVersion !== 2) return;
    for (const key of ["agents", "actions", "skills"] as const) {
      for (const [index, entry] of (manifest[key] ?? []).entries()) {
        if (typeof entry === "string") continue;
        if (entry.publicName && !ArtifactLocalNameV2Schema.safeParse(entry.publicName).success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, "publicName"],
            message: "must use the format version 2 local-name grammar",
          });
        }
        if (entry.aliases && entry.aliases.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, "aliases"],
            message: "aliases are not supported for format version 2 artifacts",
          });
        }
      }
    }
    for (const [index, binding] of (manifest.suggestedChannelBindings ?? []).entries()) {
      if (!isValidArtifactReference(binding.agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["suggestedChannelBindings", index, "agent"],
          message: "must be a qualified artifact ID in format version 2",
        });
      }
    }
  });

export type AppManifestData = z.infer<typeof AppManifestSchema>;

/** Render a Zod failure as one readable multi-line message, one issue per line. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Validate an already-YAML-parsed app.yaml object against the strict,
 * format-versioned schema. Shared by pack (`packArtifact`), install
 * (`prepare`/`AppInstaller`), and post-staging validation so every gate
 * accepts exactly the same manifests.
 */
export function parseAppManifest(obj: unknown, manifestPath: string): AppManifestData {
  const result = AppManifestSchema.safeParse(obj);
  if (!result.success) {
    throw new Error(`Invalid app manifest in ${manifestPath}:\n${formatZodIssues(result.error)}`);
  }
  return result.data;
}

/** Name of the per-app drizzle migrations meta table; the purge primitive drops it on uninstall+purge. */
export function appMigrationsTableName(tablePrefix: string): string {
  return `__drizzle_migrations_app_${tablePrefix}`;
}

/**
 * Read and YAML-parse an `app.yaml` file into a plain object. Throws with the
 * manifest path on either I/O failure or invalid YAML shape.
 */
export async function parseManifestObject(manifestPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse app manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid app manifest in ${manifestPath}`);
  }
  return parsed as Record<string, unknown>;
}

export function requireManifestId(obj: Record<string, unknown>, manifestPath: string): string {
  if (typeof obj.id !== "string" || obj.id.length === 0) {
    throw new Error(`Invalid app manifest in ${manifestPath}: missing id`);
  }
  // Validate before the id reaches lockfile, filesystem, URL, or artifact
  // namespace consumers.
  if (!isValidAppId(obj.id)) {
    throw new Error(
      `Invalid app manifest in ${manifestPath}: id ${JSON.stringify(obj.id)} must be an unscoped lowercase slug or a scoped App Store id such as "@handle/slug"`,
    );
  }
  return obj.id;
}

export function requireManifestVersion(obj: Record<string, unknown>, manifestPath: string): string {
  if (typeof obj.version !== "string" || !valid(obj.version)) {
    throw new Error(`Invalid app manifest in ${manifestPath}: missing or invalid version`);
  }
  return obj.version;
}

/**
 * The slice of a parsed manifest the pack/validate/materialize pipelines act
 * on: identity, layout (`appRoot`), and every file reference that must exist
 * in a valid artifact.
 */
export interface ManifestSummary {
  formatVersion: 1 | 2;
  id: string;
  version: string;
  appRoot?: string;
  includeSource: boolean;
  artifacts: Array<{
    kind: "agent" | "action" | "skill" | "hook";
    path: string;
    publicName?: string;
  }>;
  webManifest?: string;
  apiEntry?: string;
  dbMigrations?: string;
  iconPath?: string;
}

/** Read, strictly validate, and project an `app.yaml` into a {@link ManifestSummary}. */
export async function readManifestSummary(manifestPath: string): Promise<ManifestSummary> {
  const obj = await parseManifestObject(manifestPath);
  const manifest = parseAppManifest(obj, manifestPath);

  const summary: ManifestSummary = {
    formatVersion: manifest.formatVersion,
    id: manifest.id,
    version: manifest.version,
    appRoot: manifest.appRoot,
    includeSource: manifest.includeSource === true,
    artifacts: [],
  };

  for (const [key, kind] of [
    ["agents", "agent"],
    ["actions", "action"],
    ["skills", "skill"],
    ["hooks", "hook"],
  ] as const) {
    for (const entry of manifest[key] ?? []) {
      summary.artifacts.push({
        kind,
        path: typeof entry === "string" ? entry : entry.path,
        ...(typeof entry !== "string" && entry.publicName ? { publicName: entry.publicName } : {}),
      });
    }
  }

  if (manifest.web) summary.webManifest = manifest.web.manifest;
  if (manifest.api) summary.apiEntry = manifest.api.entry ?? "api/index";
  if (manifest.db) summary.dbMigrations = manifest.db.migrations;
  if (manifest.icon) summary.iconPath = manifest.icon;

  return summary;
}

/**
 * Slim manifest read for callers that only need `id` and `version` — verifying
 * a staged or fetched manifest without parsing the full artifact list.
 */
export async function readManifestIdAndVersion(
  manifestPath: string,
): Promise<{ id: string; version: string }> {
  const obj = await parseManifestObject(manifestPath);
  return {
    id: requireManifestId(obj, manifestPath),
    version: requireManifestVersion(obj, manifestPath),
  };
}
