import { z } from "zod";

/** A release version as the image is tagged: `major.minor.patch`, with an optional prerelease. */
export const RELEASE_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;

/**
 * The release-notes.json format versions this reader understands. 2 adds
 * `highlights` to the fields of 1.
 */
export const RELEASE_NOTES_SCHEMAS = [1, 2] as const;

/**
 * One change in a release: the commit's scope (`web`, `ios`, …), its subject
 * without the pull request suffix, and that pull request's number.
 */
export const releaseNoteEntrySchema = z.object({
  scope: z.string().nullable(),
  text: z.string(),
  pr: z.number().int().positive().nullable(),
});

/**
/**
 * One user-facing line a model wrote at release time
 * (scripts/docker/release-highlights.mjs), citing the release's pull request.
 */
export const releaseHighlightSchema = z.object({
  text: z.string().min(1),
  pr: z.number().int().positive(),
});

/**
 * The release-notes.json asset on a runtime release, written by
 * scripts/docker/release-notes.mjs (docs/releases.md#github-release).
 * `internal` counts the changes it does not list. `highlights` is absent in
 * schema 1, and in schema 2 may be empty when nothing qualified or the model
 * failed.
 */
export const releaseNotesFileSchema = z.object({
  schema: z.union([z.literal(RELEASE_NOTES_SCHEMAS[0]), z.literal(RELEASE_NOTES_SCHEMAS[1])]),
  version: z.string().regex(RELEASE_VERSION),
  previousVersion: z.string().regex(RELEASE_VERSION).nullable(),
  date: z.string(),
  url: z.string().startsWith("https://"),
  breaking: z.array(releaseNoteEntrySchema),
  new: z.array(releaseNoteEntrySchema),
  fixes: z.array(releaseNoteEntrySchema),
  internal: z.number().int().nonnegative(),
  highlights: z
    .object({ en: z.array(releaseHighlightSchema), zh: z.array(releaseHighlightSchema) })
    .optional(),
});

/**
 * A highlight in an upgrade range, with the release that made it. `breaking`
 * marks one that cites a breaking change: the owner may have to act on it.
 */
export const rangeHighlightSchema = releaseHighlightSchema.extend({
  version: z.string(),
  breaking: z.boolean(),
});

/**
 * How much of the upgrade range `GET /api/system/release-notes` covers.
 *   complete — every release from `from` (exclusive) to `to`
 *   partial  — the newest releases down to `coveredFrom`. Older notes were
 *              missing, could not be read, or lay past the walk's cap, or a
 *              release did not name its predecessor (`coveredFrom` null)
 *   missing  — the target release has no notes
 *   failed   — the target's notes could not be downloaded or read
 */
export const releaseNotesStatusSchema = z.enum(["complete", "partial", "missing", "failed"]);

export const releaseNotesRangeSchema = z.object({
  status: releaseNotesStatusSchema,
  /** The running version, or null when the request named only a target. */
  from: z.string().nullable(),
  to: z.string(),
  /** The releases covered, newest first. Empty for missing and failed. */
  releases: z.array(z.object({ version: z.string(), date: z.string(), url: z.string() })),
  /**
   * The version the covered changes count from: the oldest covered release's
   * predecessor. Null when that release does not name one.
   */
  coveredFrom: z.string().nullable(),
  /**
   * Highlights across the range in English and Chinese, newest release first,
   * one per pull request. A covered release without highlights adds none.
   */
  highlights: z.object({ en: z.array(rangeHighlightSchema), zh: z.array(rangeHighlightSchema) }),
  /** The target's release page. Set in every status, for the full notes. */
  releaseUrl: z.string(),
  /** GitHub's comparison from `from` to `to`, when the request named both. */
  compareUrl: z.string().nullable(),
});

export type ReleaseNoteEntry = z.infer<typeof releaseNoteEntrySchema>;
export type ReleaseNotesFile = z.infer<typeof releaseNotesFileSchema>;
export type ReleaseNotesRangeHighlight = z.infer<typeof rangeHighlightSchema>;
export type ReleaseNotesStatus = z.infer<typeof releaseNotesStatusSchema>;
export type ReleaseNotesRange = z.infer<typeof releaseNotesRangeSchema>;
