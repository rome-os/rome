import { z } from "zod";

/** A release version as the image is tagged: `major.minor.patch`, with an optional prerelease. */
export const RELEASE_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;

/** The release-notes.json format version this reader understands. */
export const RELEASE_NOTES_SCHEMA = 1;

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
 * The release-notes.json asset on a runtime release, written by
 * scripts/docker/release-notes.mjs (docs/releases.md#github-release).
 * `internal` counts the changes it does not list.
 */
export const releaseNotesFileSchema = z.object({
  schema: z.literal(RELEASE_NOTES_SCHEMA),
  version: z.string().regex(RELEASE_VERSION),
  previousVersion: z.string().regex(RELEASE_VERSION).nullable(),
  date: z.string(),
  url: z.string().startsWith("https://"),
  breaking: z.array(releaseNoteEntrySchema),
  new: z.array(releaseNoteEntrySchema),
  fixes: z.array(releaseNoteEntrySchema),
  internal: z.number().int().nonnegative(),
});

/** A change in an upgrade range, with the release that made it. */
export const rangeEntrySchema = releaseNoteEntrySchema.extend({ version: z.string() });

/**
 * How much of the upgrade range `GET /api/system/release-notes` covers.
 *   complete — every release from `from` (exclusive) to `to`
 *   partial  — the newest releases down to `coveredFrom`. Older notes were
 *              missing, could not be read, or lay past the walk's cap
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
  /** The version the covered changes count from: the oldest covered release's predecessor. */
  coveredFrom: z.string().nullable(),
  /** Breaking changes across the range, newest release first. */
  breaking: z.array(rangeEntrySchema),
  /** New features across the range, one entry per pull request. */
  new: z.array(rangeEntrySchema),
  /** Fixes across the range, one entry per pull request. */
  fixes: z.array(rangeEntrySchema),
  /** Changes the notes do not list, summed over the covered releases. */
  internal: z.number().int().nonnegative(),
  /** The target's release page. Set in every status, for the full notes. */
  releaseUrl: z.string(),
  /** GitHub's comparison from `from` to `to`, when the request named both. */
  compareUrl: z.string().nullable(),
});

export type ReleaseNoteEntry = z.infer<typeof releaseNoteEntrySchema>;
export type ReleaseNotesFile = z.infer<typeof releaseNotesFileSchema>;
export type ReleaseNotesRangeEntry = z.infer<typeof rangeEntrySchema>;
export type ReleaseNotesStatus = z.infer<typeof releaseNotesStatusSchema>;
export type ReleaseNotesRange = z.infer<typeof releaseNotesRangeSchema>;
