import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceArchivesRepository } from "../db/repositories/trace-archives.js";
import { createLogger } from "../logger.js";
import type { TraceArchiver } from "./trace-archive.js";

const log = createLogger("trace-archive");
const GiB = 1024 ** 3;
export interface VacuumGuards {
  pageSize: number;
  pageCount: number;
  freelist: number;
  freeDisk: number;
  now: Date;
  timezone: string;
  turnRunning: boolean;
  lastActivityAt: number | null;
  routineDue: boolean;
}

export function canVacuumTraces(g: VacuumGuards): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en", {
      timeZone: g.timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(g.now),
  );
  const free = g.freelist * g.pageSize;
  const live = (g.pageCount - g.freelist) * g.pageSize;
  return (
    free >= GiB &&
    free >= (g.pageCount * g.pageSize) / 4 &&
    hour >= 2 &&
    hour < 6 &&
    !g.turnRunning &&
    !g.routineDue &&
    (g.lastActivityAt === null || g.now.getTime() - g.lastActivityAt >= 30 * 60_000) &&
    g.freeDisk >= 2 * live + GiB
  );
}

export function vacuumTraceDatabase(
  repo: TraceArchivesRepository,
  options: { timezone: string; turnRunning: boolean; now?: Date },
): boolean {
  const now = options.now ?? new Date();
  const db = repo.sqlite;
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const pageCount = Number(db.pragma("page_count", { simple: true }));
  const freelist = Number(db.pragma("freelist_count", { simple: true }));
  // Avoid scanning activity or disk for the usual case of a nearly full database.
  if (freelist * pageSize < GiB || freelist < pageCount / 4) return false;
  const disk = statfsSync(dirname(db.name));
  if (
    !canVacuumTraces({
      ...options,
      ...repo.quietState(now),
      now,
      pageSize,
      pageCount,
      freelist,
      freeDisk: disk.bavail * disk.bsize,
    })
  )
    return false;
  const before = statSync(db.name).size;
  const start = performance.now();
  log.info("trace archive quiet-window vacuum starting", { beforeBytes: before });
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  log.info("trace archive quiet-window vacuum completed", {
    beforeBytes: before,
    afterBytes: statSync(db.name).size,
    durationMs: performance.now() - start,
  });
  return true;
}

/** The first archive pass is delayed. VACUUM is checked hourly, never during boot. */
export function startTraceArchiveMaintenance(options: {
  archiver: TraceArchiver;
  vacuum: () => Promise<void>;
}): () => Promise<unknown> {
  let daily: ReturnType<typeof setInterval> | undefined;
  const run = () => {
    void options.archiver.runPass().catch(() => log.warn("trace archive pass failed"));
  };
  const first = setTimeout(() => {
    run();
    daily = setInterval(run, 24 * 60 * 60_000);
    daily.unref();
  }, 10 * 60_000);
  first.unref();
  const quiet = setInterval(() => {
    void options.vacuum().catch(() => log.warn("trace archive vacuum failed"));
  }, 60 * 60_000);
  quiet.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
    clearInterval(quiet);
    return options.archiver.stop();
  };
}
