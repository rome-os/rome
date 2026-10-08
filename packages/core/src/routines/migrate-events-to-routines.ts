import { eq } from "drizzle-orm";
import { z } from "zod";
import { events } from "../db/schema.js";
import type { DrizzleDb } from "../db/index.js";
import type { RoutinesRepository } from "../db/repositories/routines.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { ScheduleTrigger } from "./types.js";
import { createLogger } from "../logger.js";

const log = createLogger("events-to-routines-migration");

/** Settings key that records the one-shot events→routines migration ran. Once
 * set, the migration is skipped on every subsequent boot. */
export const EVENTS_MIGRATED_FLAG = "events_to_routines_migrated";

export interface MigrateEventsToRoutinesDeps {
  db: DrizzleDb;
  routinesRepo: RoutinesRepository;
  settingsRepo: SettingsRepository;
  /** Injectable clock so tests can pin "now" for the past-one-off cutoff. */
  now?: Date;
}

export interface MigrateEventsToRoutinesResult {
  alreadyMigrated: boolean;
  eventsRead: number;
  routinesCreated: number;
  skippedPastOneOff: number;
  skippedInvalid: number;
}

/** The subset of a legacy `events` row the migration consumes, validated at the
 * read boundary. The JSON columns read back as `unknown`, and one historical
 * write path (the old POST /api/events route) never validated `args` — so we
 * parse rather than cast. A row that fails the schema is logged and skipped,
 * never silently coerced. */
const eventRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["one-off", "recurring"]),
  tzid: z.string(),
  localTime: z.string(),
  rrule: z.string().nullable(),
  startTime: z.date(),
  actionName: z.string(),
  args: z.array(z.record(z.string(), z.unknown())),
});

/** Derive the YYYY-MM-DD calendar date and HH:mm wall-clock time that `instant`
 * lands on in `tzid`. The inverse is `parseDateAndLocalTime` in the schedule
 * trigger provider, so feeding these back reproduces `instant` (minute
 * granularity). */
function wallClockInTz(instant: Date, tzid: string): { date: string; localTime: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  // Intl can emit "24" for midnight in some locales — normalize to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${hour}:${parts.minute}`,
  };
}

/** Create one routine per arg object. A single arg keeps the event's name; an
 * array of >1 args fans out into "<name> #1", "<name> #2", … because routines
 * intentionally dropped the legacy per-fire fan-out. An empty arg list yields a
 * single routine with `{}` args. */
async function createRoutines(
  routinesRepo: RoutinesRepository,
  baseName: string,
  trigger: ScheduleTrigger,
  actionName: string,
  argsList: Record<string, unknown>[],
): Promise<number> {
  if (argsList.length === 0) {
    await routinesRepo.create({ name: baseName, trigger, actionName, args: {}, enabled: true });
    return 1;
  }
  const fanOut = argsList.length > 1;
  for (let i = 0; i < argsList.length; i++) {
    await routinesRepo.create({
      name: fanOut ? `${baseName} #${i + 1}` : baseName,
      trigger,
      actionName,
      args: argsList[i],
      enabled: true,
    });
  }
  return argsList.length;
}

/**
 * One-shot migration of the deprecated `events` table into `routines`.
 *
 * Reads the retained-but-deprecated `events` table directly (its repository was
 * removed when the Events subsystem was retired), and recreates each enabled
 * event as one or more schedule-triggered routines. Idempotent via a settings
 * flag.
 *
 * Must run after schema migrations and before the routine engine starts so the
 * engine activates the freshly-created routines.
 */
export async function migrateEventsToRoutines(
  deps: MigrateEventsToRoutinesDeps,
): Promise<MigrateEventsToRoutinesResult> {
  const { db, routinesRepo, settingsRepo } = deps;
  const now = deps.now ?? new Date();

  if (await settingsRepo.get<boolean>(EVENTS_MIGRATED_FLAG)) {
    return {
      alreadyMigrated: true,
      eventsRead: 0,
      routinesCreated: 0,
      skippedPastOneOff: 0,
      skippedInvalid: 0,
    };
  }

  // Only enabled events were ever live under the old scheduler; disabled rows
  // are consumed one-offs or archived schedules and carry no firing intent.
  const rows = await db.select().from(events).where(eq(events.enabled, true));

  let routinesCreated = 0;
  let skippedPastOneOff = 0;
  let skippedInvalid = 0;

  for (const rawRow of rows) {
    const parsed = eventRowSchema.safeParse(rawRow);
    if (!parsed.success) {
      // A single malformed row must not poison the whole migration — skip it
      // loudly and keep draining the rest.
      skippedInvalid += 1;
      log.warn("skipping events row that failed validation", {
        eventId: (rawRow as { id?: unknown }).id,
        error: parsed.error.message,
      });
      continue;
    }
    const row = parsed.data;
    const argsList = row.args;

    if (row.type === "recurring") {
      const trigger: ScheduleTrigger = {
        type: "schedule",
        tzid: row.tzid,
        // Legacy events fired in their stored tzid as an absolute zone — keep
        // that faithfully; migration must not silently relocate them.
        tzMode: "fixed",
        localTime: row.localTime,
        // A recurring event with no rrule fired daily at localTime in the old
        // scheduler. An empty rrule would make the new provider treat the
        // routine as a one-off, so pin DAILY to preserve the cadence.
        rrule: row.rrule ?? "FREQ=DAILY",
      };
      routinesCreated += await createRoutines(
        routinesRepo,
        row.name,
        trigger,
        row.actionName,
        argsList,
      );
      continue;
    }

    // one-off: the old scheduler fired at the absolute `startTime` instant and
    // ignored `localTime`. Reconstruct that instant as date + wall-clock time
    // in the event's tz so the date-based provider fires at the same moment.
    const startTime = row.startTime;
    if (startTime.getTime() <= now.getTime()) {
      // A past one-off would never fire — croner does not run a schedule pinned
      // to a past instant. Drop it rather than persist a dead routine.
      skippedPastOneOff += 1;
      log.warn("skipping past-dated one-off event", {
        eventId: row.id,
        name: row.name,
        startTime: startTime.toISOString(),
      });
      continue;
    }

    const { date, localTime } = wallClockInTz(startTime, row.tzid);
    if (localTime !== row.localTime) {
      log.warn(
        "one-off startTime wall-clock differs from stored localTime; using startTime-derived time",
        {
          eventId: row.id,
          name: row.name,
          storedLocalTime: row.localTime,
          derivedLocalTime: localTime,
        },
      );
    }
    const trigger: ScheduleTrigger = {
      type: "schedule",
      tzid: row.tzid,
      // Fixed: a migrated one-off must fire at the same absolute instant, which
      // means resolving date+localTime against the original tzid, not the
      // guardian's current zone.
      tzMode: "fixed",
      localTime,
      date,
    };
    routinesCreated += await createRoutines(
      routinesRepo,
      row.name,
      trigger,
      row.actionName,
      argsList,
    );
  }

  await settingsRepo.set(EVENTS_MIGRATED_FLAG, true);
  log.info("events→routines migration complete", {
    eventsRead: rows.length,
    routinesCreated,
    skippedPastOneOff,
    skippedInvalid,
  });

  return {
    alreadyMigrated: false,
    eventsRead: rows.length,
    routinesCreated,
    skippedPastOneOff,
    skippedInvalid,
  };
}
