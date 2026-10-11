/**
 * App packaging — the core-independent building blocks of the app lifecycle.
 *
 * Internal and unstable: this entry exists for the Rome host and the `rome`
 * CLI. App code must not import it, and a change here is not a breaking
 * change to the SDK.
 *
 * Everything an app *is* before it touches a Rome instance lives here:
 *
 *   - Contract  — strict `app.yaml` schema (formatVersion, unknown-field
 *     rejection; one schema for pack-time and install-time), app-id rules,
 *     per-artifact YAML schemas, `validateInstalledArtifact`.
 *   - Recognition — `classifyAppDir`, the pack sentinel, source markers,
 *     the `.rome/artifact` convention.
 *   - Production — `buildSourceWorkspace`, `packArtifact`.
 *   - Identity & bytes — `hashWorkspace`/`hashArtifact`, `packBundle`.
 *
 * What does NOT live here: instance state transitions — the lockfile state
 * machine, materialization (`prepare`), the catalog, the store client. Core
 * owns those and consumes this module as `@rome-os/app-runtime/packaging`.
 * The `rome` CLI consumes it too, so `rome validate` runs the same checks an
 * install does. Nothing under `packaging/` imports from outside it (enforced
 * by a Biome `noRestrictedImports` override) except the SDK's own public
 * entry, `@rome-os/app-runtime`.
 */
export {
  APP_ID_PATTERN,
  RESERVED_APP_IDS,
  appIdToPathSegment,
  assertValidAppId,
  isValidAppId,
} from "./app-id.js";
export {
  LISTING_HANDLE_PATTERN,
  LISTING_SLUG_PATTERN,
  parseListingId,
  type ParsedListingId,
} from "./listing-id.js";
export {
  APP_MANIFEST_FORMAT_VERSION,
  SUPPORTED_APP_MANIFEST_FORMAT_VERSIONS,
  AppManifestSchema,
  ArtifactEntrySchema,
  TABLE_PREFIX_PATTERN,
  appMigrationsTableName,
  formatZodIssues,
  parseAppManifest,
  parseManifestObject,
  readManifestIdAndVersion,
  readManifestSummary,
  requireManifestId,
  requireManifestVersion,
  type AppManifestData,
  type ManifestSummary,
} from "./manifest.js";
export { ActionConfigSchema, AgentConfigSchema } from "./artifact-config.js";
export {
  PortableOutputSchemaError,
  assertPortableOutputSchema,
  compileJsonSchema,
  compileOutputSchema,
  formatOutputSchemaErrors,
  validatePortableOutputSchema,
  type CompiledOutputSchema,
} from "./output-schema-validator.js";
export {
  parseSkillFrontmatter,
  parseSkillFrontmatterResult,
  type SkillFrontmatter,
  type SkillFrontmatterErrorReason,
  type SkillFrontmatterResult,
} from "./skill-frontmatter.js";
export {
  ARTIFACT_LOCAL_NAME_PATTERN,
  ARTIFACT_NAMESPACE_SEPARATOR,
  ArtifactLocalNameSchema,
  ArtifactLocalNameV2Schema,
  isValidArtifactReference,
} from "./artifact-name.js";
export { BuildValidationError, validateInstalledArtifact } from "./validate.js";
export {
  PACKED_ARTIFACT_SENTINEL,
  classifyAppDir,
  hasSourceWorkspaceMarkers,
  sourceRootForArtifactPath,
  type AppDirKind,
} from "./recognition.js";
export {
  buildSourceWorkspace,
  isBlockedSourceFile,
  isExcludedSourceEntry,
  packArtifact,
  readPackageManifest,
  PNPM_TIMEOUT_MESSAGE_PREFIX,
  SOURCE_EXCLUDED_SEGMENTS,
  runPnpm,
  type BuildSourceWorkspaceOptions,
  type PackOptions,
  type PackageJsonManifest,
  type PackedArtifact,
} from "./pack.js";
export { hashArtifact, hashWorkspace } from "./hash.js";
export { packBundle } from "./bundle.js";
export { resolvePathWithinBase, safeIsDir, safeIsFile } from "./path-utils.js";
export { widthUnits } from "./width-units.js";
export {
  appIdToDisplayName,
  isDirectoryNonEmpty,
  materializeTemplate,
  type TemplateVars,
} from "./template.js";
export {
  MODULE_RESOLVER_OPTIONS,
  type ModuleSpecifierResolver,
  resolveActionFactory,
  resolveApiEntryPath,
  resolveModuleEntryPath,
} from "./module-entry.js";
