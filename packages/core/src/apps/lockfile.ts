import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  AppstoreSourceSchema,
  BundleSourceSchema,
  PERSISTED_APP_STATES,
  SourceDirSourceSchema,
  SpecSourceSchema,
  type AppstoreSource,
  type BundleSource,
  type SourceDirSource,
  type SpecSource,
} from "@rome/api-types/apps";

export {
  AppstoreSourceSchema,
  BundleSourceSchema,
  SourceDirSourceSchema,
  SpecSourceSchema,
  type AppstoreSource,
  type BundleSource,
  type SourceDirSource,
  type SpecSource,
};

const AppErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export type AppError = z.infer<typeof AppErrorSchema>;

export const AppEntrySchema = z.object({
  source: SpecSourceSchema,
  enabled: z.boolean(),
  /**
   * True for apps shipped with Rome (installed at boot from the packed
   * first-party artifacts). First-party apps cannot be uninstalled — the
   * AppManager rejects the attempt at the daemon boundary. The flag is
   * recorded durably here at install time so uninstall never has to infer
   * first-party identity from paths. Defaults false so entries written
   * before the flag existed still parse; boot re-marks every first-party
   * app, converging old lockfiles.
   */
  firstParty: z.boolean().default(false),
  state: z.enum(PERSISTED_APP_STATES),
  installedHash: z.string().min(1).nullable(),
  installedVersion: z.string().min(1).nullable(),
  /**
   * When this app first installed successfully. Written once: upgrades,
   * re-installs and the boot first-party pass keep the recorded value.
   * Optional so lockfiles written before the field existed still parse
   * without a schemaVersion bump. Absent means "unknown" and is never
   * backfilled, so upgrading an old app does not make it look new.
   */
  installedAt: z.string().datetime().optional(),
  lastError: AppErrorSchema.nullable(),
  updatedAt: z.string().datetime({ message: "updatedAt must be ISO-8601" }),
});

export type AppEntry = z.infer<typeof AppEntrySchema>;

export const APPS_LOCKFILE_SCHEMA_VERSION = 3 as const;

export const AppLockfileSchema = z.object({
  schemaVersion: z.literal(APPS_LOCKFILE_SCHEMA_VERSION),
  apps: z.record(z.string(), AppEntrySchema),
});

export type AppLockfile = z.infer<typeof AppLockfileSchema>;

export function emptyLockfile(): AppLockfile {
  return { schemaVersion: APPS_LOCKFILE_SCHEMA_VERSION, apps: {} };
}

export function nowIso(): string {
  return new Date().toISOString();
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Lockfiles written before the source-mode split record local installs as
 * `mode: "workspace"`; the same shape is now spelled `mode: "bundle"`.
 * Normalize at read so existing entries parse and converge to the new
 * spelling on the next write.
 */
function normalizeLegacySourceMode(rawEntry: unknown): unknown {
  if (rawEntry == null || typeof rawEntry !== "object") return rawEntry;
  const entry = rawEntry as Record<string, unknown>;
  const source = entry.source;
  if (source == null || typeof source !== "object") return rawEntry;
  if ((source as Record<string, unknown>).mode !== "workspace") return rawEntry;
  return { ...entry, source: { ...(source as Record<string, unknown>), mode: "bundle" } };
}

/**
 * Top-level JSON parse failure for `apps.lock.json`. Catastrophic — boot
 * surfaces this loudly because the file's outer shape can't be trusted.
 */
export class LockfileTopLevelError extends Error {
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(
      `Failed to read top-level apps lockfile at ${path}: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "LockfileTopLevelError";
  }
}

export interface ReadLockfileResult {
  lockfile: AppLockfile;
  /** Per-entry parse failures that have been salvaged into broken-state entries. */
  brokenEntries: ReadonlyArray<{ appId: string; reason: string }>;
}

/**
 * Read the lockfile with per-entry isolation. A malformed entry is rewritten
 * in memory as a `broken` AppEntry; a malformed top-level JSON / schemaVersion
 * throws `LockfileTopLevelError` and forces operator intervention.
 *
 * Caller must persist via `writeLockfile` to materialize broken-state fixups.
 */
export async function readLockfileWithEntryIsolation(
  lockfilePath: string,
): Promise<ReadLockfileResult> {
  let raw: string;
  try {
    raw = await readFile(lockfilePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { lockfile: emptyLockfile(), brokenEntries: [] };
    }
    throw new LockfileTopLevelError(lockfilePath, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LockfileTopLevelError(lockfilePath, err);
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LockfileTopLevelError(lockfilePath, new Error("expected JSON object at root"));
  }

  const outer = parsed as Record<string, unknown>;
  const observedVersion = outer.schemaVersion;
  if (observedVersion !== APPS_LOCKFILE_SCHEMA_VERSION) {
    throw new LockfileTopLevelError(
      lockfilePath,
      new Error(
        `unsupported schemaVersion: expected ${APPS_LOCKFILE_SCHEMA_VERSION}, got ${String(observedVersion)}`,
      ),
    );
  }

  const rawApps = outer.apps;
  if (rawApps == null || typeof rawApps !== "object" || Array.isArray(rawApps)) {
    throw new LockfileTopLevelError(lockfilePath, new Error("expected `apps` to be an object"));
  }

  const brokenEntries: Array<{ appId: string; reason: string }> = [];
  const validApps: Record<string, AppEntry> = {};
  for (const [appId, rawEntry] of Object.entries(rawApps as Record<string, unknown>)) {
    const result = AppEntrySchema.safeParse(normalizeLegacySourceMode(rawEntry));
    if (result.success) {
      validApps[appId] = result.data;
      continue;
    }
    const reason = formatZodIssues(result.error);
    const raw = (rawEntry ?? {}) as Record<string, unknown>;
    const installedHash = typeof raw.installedHash === "string" ? raw.installedHash : null;
    const installedVersion = typeof raw.installedVersion === "string" ? raw.installedVersion : null;
    const fallbackSource: SpecSource = ((): SpecSource => {
      const candidate = SpecSourceSchema.safeParse(raw.source);
      return candidate.success ? candidate.data : { mode: "bundle", path: "<UNKNOWN>" };
    })();
    validApps[appId] = {
      source: fallbackSource,
      enabled: false,
      firstParty: typeof raw.firstParty === "boolean" ? raw.firstParty : false,
      state: "broken",
      installedHash,
      installedVersion,
      lastError: { code: "SCHEMA", message: reason },
      updatedAt: nowIso(),
    };
    brokenEntries.push({ appId, reason });
  }

  return {
    lockfile: { schemaVersion: APPS_LOCKFILE_SCHEMA_VERSION, apps: validApps },
    brokenEntries,
  };
}

/**
 * Atomic write: tmp file in same directory, fsync, rename, fsync the parent
 * dir. Best-effort directory fsync on platforms that reject opening a dir.
 */
export async function atomicWriteJson(path: string, payload: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify(payload, null, 2) + "\n";
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, body, "utf-8");
  const fh = await open(tmp, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  try {
    const dirFh = await open(dir, "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  } catch {
    // best-effort
  }
}

export async function writeLockfile(lockfilePath: string, lockfile: AppLockfile): Promise<void> {
  const validated = AppLockfileSchema.parse(lockfile);
  await atomicWriteJson(lockfilePath, validated);
}

export function lockfileExists(lockfilePath: string): boolean {
  return existsSync(lockfilePath);
}
