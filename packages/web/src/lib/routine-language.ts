import { artifactLocalName } from "./artifact-name";

// Pure, client-side derivation of every guardian-facing routine sentence from
// mechanism alone (trigger + actionName + args + run state). Nothing here reads
// a stored intent/description field — by design, so the behavior text can never
// drift from the schedule it describes. If a routine's trigger changes, its
// sentence changes with it on the next read.

export interface ScheduleTrigger {
  type: "schedule";
  tzid: string;
  // `fixed` pins `tzid`; `floating` follows the guardian's current zone, so
  // `tzid` is just a snapshot.
  tzMode: "fixed" | "floating";
  localTime: string;
  date?: string;
  rrule?: string;
}

export interface EventBusTrigger {
  type: "event-bus";
  eventName: string;
  sourcePattern?: string;
}

// A routine that never fires on its own; it only runs via "Run now".
export interface ManualTrigger {
  type: "manual";
}

export type Trigger = ScheduleTrigger | EventBusTrigger | ManualTrigger;

export interface Routine {
  id: string;
  name: string;
  // The app that owns this routine, if any. A managed routine can't be deleted
  // from the dashboard (the server refuses too); only the owning app removes it.
  managedBy?: string | null;
  enabled: boolean;
  trigger: Trigger;
  actionName: string;
  args: Record<string, unknown>;
  createdAt: string;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  // The most recent run, attached by GET /routines so the card can show its
  // status badge (Active / Running / Failed) without a per-card request.
  lastRun?: { status: RoutineRun["status"]; firedAt: string } | null;
}

export function isScheduleTrigger(tr: Trigger): tr is ScheduleTrigger {
  return tr.type === "schedule";
}

export function isEventTrigger(tr: Trigger): tr is EventBusTrigger {
  return tr.type === "event-bus";
}

// Schedule → trigger phrase

const WEEKDAY_ORDER = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAY_LONG: Record<string, string> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
};

function parseRrule(rrule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rrule.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) out[k.trim().toUpperCase()] = v.trim();
  }
  return out;
}

// Render "9:00 AM" from "HH:mm". Falls back to the raw value if it is not the
// expected 24h shape, so we never silently drop a time we can't parse.
function formatLocalTime12h(localTime: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(localTime);
  if (!m) return localTime;
  let hour = Number(m[1]);
  const minute = m[2];
  const meridiem = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${meridiem}`;
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return `${n}st`;
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`;
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`;
  return `${n}th`;
}

// Returns true when the trigger timezone differs from the browser's, so the
// caller can append the tzid for honesty ("...(America/Los_Angeles)") instead
// of showing a local-looking time that is actually pinned to another zone.
function tzDiffersFromBrowser(tzid: string): boolean {
  try {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return Boolean(tzid) && Boolean(browser) && tzid !== browser;
  } catch {
    return false;
  }
}

function tzSuffix(tzid: string): string {
  return tzDiffersFromBrowser(tzid) ? ` (${tzid})` : "";
}

const RRULE_WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];

function describeByDay(byday: string, time: string, suffix: string): string {
  const days = byday.split(",").map((d) => d.trim().toUpperCase());
  const set = new Set(days);
  const isWeekdays =
    set.size === 5 && RRULE_WEEKDAYS.every((d) => set.has(d)) && !set.has("SA") && !set.has("SU");
  if (isWeekdays) return `Every weekday at ${time}${suffix}`;
  const allSeven = set.size === 7;
  if (allSeven) return `Every day at ${time}${suffix}`;
  const ordered = WEEKDAY_ORDER.filter((d) => set.has(d)).map((d) => WEEKDAY_LONG[d]);
  if (ordered.length === 1) return `Every ${ordered[0]} at ${time}${suffix}`;
  return `Every ${ordered.join(", ")} at ${time}${suffix}`;
}

// Schedule trigger → "Every weekday at 9:00 AM", "Every day at 6:00 PM",
// "Every Monday at 9:00 AM", or one-off "On Mon, May 5 at 9:00 AM".
export function describeSchedule(trigger: ScheduleTrigger): string {
  const time = formatLocalTime12h(trigger.localTime);
  // Only a `fixed` schedule is pinned to `tzid`; a floating one fires in the
  // guardian's current zone (≈ the browser's), so a zone suffix would lie about
  // when it runs.
  const suffix = trigger.tzMode === "fixed" ? tzSuffix(trigger.tzid) : "";

  if (trigger.date) {
    const d = new Date(`${trigger.date}T00:00:00`);
    if (!isNaN(d.getTime())) {
      const datePart = d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      return `On ${datePart} at ${time}${suffix}`;
    }
    return `On ${trigger.date} at ${time}${suffix}`;
  }

  if (trigger.rrule) {
    const r = parseRrule(trigger.rrule);
    const freq = r.FREQ;
    const interval = r.INTERVAL ? Number(r.INTERVAL) : 1;

    if (freq === "MINUTELY") {
      return interval === 1 ? "Every minute" : `Every ${interval} minutes`;
    }
    if (freq === "HOURLY") {
      return interval === 1 ? "Every hour" : `Every ${interval} hours`;
    }
    if (freq === "WEEKLY" && r.BYDAY) {
      return describeByDay(r.BYDAY, time, suffix);
    }
    if (freq === "WEEKLY") {
      return interval === 1
        ? `Every week at ${time}${suffix}`
        : `Every ${interval} weeks at ${time}${suffix}`;
    }
    if (freq === "MONTHLY" && r.BYMONTHDAY) {
      const day = Number(r.BYMONTHDAY);
      return `On the ${ordinal(day)} of every month at ${time}${suffix}`;
    }
    if (freq === "YEARLY" && r.BYMONTH && r.BYMONTHDAY) {
      const monthName = new Date(2000, Number(r.BYMONTH) - 1, 1).toLocaleDateString(undefined, {
        month: "long",
      });
      return `Every ${monthName} ${ordinal(Number(r.BYMONTHDAY))} at ${time}${suffix}`;
    }
    if (freq === "DAILY") {
      return interval === 1
        ? `Every day at ${time}${suffix}`
        : `Every ${interval} days at ${time}${suffix}`;
    }
    // Unknown FREQ shape: render the time honestly without inventing a cadence.
    return `On a schedule at ${time}${suffix}`;
  }

  // Legacy: localTime only, no rrule/date.
  return `Once at ${time}${suffix}`;
}

// Event name → trigger phrase

// Turn "connector:GMAIL_NEW_MESSAGE" into "a gmail new message event happens",
// "order.created" into "an order created event happens". We do not pretend to
// know the semantics; we surface the raw name readably.
function humanizeEventName(eventName: string): string {
  const tail = eventName.includes(":")
    ? eventName.slice(eventName.lastIndexOf(":") + 1)
    : eventName;
  const words = tail
    .replace(/[._:]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  if (!words) return `the ${eventName} event happens`;
  return `${/^[aeiou]/.test(words) ? "an" : "a"} ${words} event happens`;
}

export function describeEvent(trigger: EventBusTrigger): string {
  const base = humanizeEventName(trigger.eventName);
  if (trigger.sourcePattern) return `${base} (from ${trigger.sourcePattern})`;
  return base;
}

// Full trigger phrase for the card's primary line, capitalized as a sentence
// opener: "Every weekday at 9:00 AM" / "Whenever a new order comes in".
export function describeTrigger(trigger: Trigger): string {
  if (isScheduleTrigger(trigger)) return describeSchedule(trigger);
  if (isEventTrigger(trigger)) return `Whenever ${describeEvent(trigger)}`;
  return "Only when you run it";
}

// actionName + args → outcome phrase

// The dashboard has no API that exposes an action's guardian-facing description
// prose, so outcome text is derived purely by humanizing the actionName and
// folding in an obvious message/text arg when present. This stays honest: it
// never claims specificity the args don't carry.
const KNOWN_OUTCOMES: Record<string, string> = {
  send_message: "send you a message",
  send_reminder: "send you a reminder",
  notify_guardian: "let you know",
  create_routine: "set up another routine",
  delete_routine: "remove a routine",
  summon: "spin up an agent to help",
};

function humanizeActionName(actionName: string): string {
  const localName = artifactLocalName(actionName);
  const words = localName
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words || localName;
}

function pickMessageArg(args: Record<string, unknown>): string | null {
  for (const key of ["message", "text", "body", "content"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim().length > 0) {
      const trimmed = v.trim();
      return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
    }
  }
  return null;
}

export function describeOutcome(actionName: string, args: Record<string, unknown>): string {
  const localName = artifactLocalName(actionName);
  const base = KNOWN_OUTCOMES[localName] ?? humanizeActionName(localName);
  const msg = pickMessageArg(args);
  // Only fold in a message arg for message-shaped actions, where quoting it
  // reads naturally ("send you a message: \"...\"").
  if (msg && (base.includes("message") || base.includes("reminder") || base.includes("know"))) {
    return `${base}: "${msg}"`;
  }
  return base;
}

// Agent-created routines often name themselves after the action they run,
// which reads as no name at all.
export function hasOwnName(routine: Pick<Routine, "name" | "actionName">): boolean {
  const trimmed = routine.name.trim();
  return (
    trimmed !== "" &&
    trimmed !== routine.actionName &&
    trimmed !== artifactLocalName(routine.actionName)
  );
}

/** What the routine is called: its own name, else the humanized outcome. Never
 * surfaces the snake_case action id. */
export function routineDisplayName(routine: Pick<Routine, "name" | "actionName" | "args">): string {
  if (hasOwnName(routine)) return routine.name.trim();
  const outcome = describeOutcome(routine.actionName, routine.args);
  return outcome.charAt(0).toUpperCase() + outcome.slice(1);
}

// Relative time

// "in 5 minutes", "yesterday", "Tuesday", "Jun 5" — a small honest formatter so
// the page reads in plain language. `now` is injectable for deterministic tests.
export function relativeTime(dateStr: string | null, now: number = Date.now()): string {
  if (!dateStr) return "unknown";
  const target = new Date(dateStr).getTime();
  if (isNaN(target)) return "unknown";

  const diff = target - now;
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  if (abs < 60_000) return future ? "in under a minute" : "just now";
  if (minutes < 60) {
    const unit = minutes === 1 ? "minute" : "minutes";
    return future ? `in ${minutes} ${unit}` : `${minutes} ${unit} ago`;
  }
  if (hours < 24) {
    const unit = hours === 1 ? "hour" : "hours";
    return future ? `in ${hours} ${unit}` : `${hours} ${unit} ago`;
  }
  if (days === 1) return future ? "tomorrow" : "yesterday";
  if (days < 7) {
    // Within the week, a weekday name reads better than "in 4 days".
    return new Date(target).toLocaleDateString(undefined, { weekday: "long" });
  }
  return new Date(target).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Absolute time-of-day for the schedule summary line: "9:00 AM".
export function formatClock(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Run history → plain language

// Trimmed to exactly what the page consumes. The runs endpoint returns more
// (executionId, payload, durationMs, error), but the guardian only ever sees a
// status + a relative time, so the interface advertises only those.
export interface RoutineRun {
  id: string;
  status: "success" | "error" | "running" | "pending_approval" | "cancelled";
  firedAt: string;
  // Present once a run reaches a terminal status. The detail view shows them
  // per run; the card's mini-history doesn't.
  durationMs?: number | null;
  error?: string | null;
}
