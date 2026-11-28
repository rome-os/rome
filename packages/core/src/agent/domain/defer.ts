// What `defer` takes: a name for what the agent watches and when it wakes.
// Session model: docs/concepts/sessions.md.

import {
  COMPUTER_CONSENT_EVENT,
  COMPUTER_CONSENT_SOURCE,
  validateConsentWatch,
} from "./consent-watch.js";
import { z } from "zod";

const MINUTE_MS = 60_000;

/** When a deferred session wakes, under the name the agent gave what it watches:
 * at a minute-aligned instant, or on the next event that matches. `note` is
 * the agent's self-contained note-to-self, which the woken turn always
 * receives, since another session than the one that deferred may wake to it. */
export type WakeUp =
  | { kind: "time"; name: string; note: string; fireAtMs: number; chatId?: string }
  | {
      kind: "event";
      name: string;
      note: string;
      /** The event to wait for. */
      event: Omit<DeferEvent, "deadline" | "waitingFor" | "expiresInMs">;
      /** What the chat shows while it waits. */
      waitingFor?: string;
      /** When to wake without an event, in epoch milliseconds. */
      deadlineMs?: number;
      chatId?: string;
    };

export type ParsedDefer = { ok: true; wakeUp: WakeUp } | { ok: false; error: string };

// Strict: an unknown key (say, a field nested one level off) is an error the
// model sees and fixes, not a field silently dropped.
const deferEventSchema = z.strictObject({
  eventName: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, { message: "defer.event.eventName is required" }),
  sourcePattern: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, {
      message: "defer.event.sourcePattern must be non-empty when provided",
    })
    .optional(),
  filter: z
    .array(
      z.object({
        field: z
          .string()
          .transform((value) => value.trim())
          .refine((value) => value.length > 0 && value.split(".").every((seg) => seg.trim()), {
            message: "defer.event.filter field must be a dot-path with no empty segments",
          }),
        equals: z.string(),
      }),
    )
    .optional(),
  waitingFor: z
    .string()
    .transform((value) => value.trim())
    .optional(),
  deadline: z.string().optional(),
  afterRevision: z.number().optional(),
  expiresInMs: z.number().int().nonnegative().optional(),
});

const WAITING_FOR_REQUIRED =
  'defer.event.waitingFor is required — a few words saying what you wait for, e.g. "the CI run"';
const DEADLINE_REQUIRED =
  "defer.event.deadline is required — when to wake anyway if the event never comes";

type DeferEvent = z.infer<typeof deferEventSchema>;

/** The `defer` tool input. The MCP boundary already validates the model's call
 * against the advertised JSON schema,
 * so field types are guaranteed by the time we get here; this schema is the
 * runtime source of truth that also encodes the constraints a JSON schema
 * can't express — exactly one of `afterMinutes`, `at` or `event` is required.
 * The future-time check stays in code (a schema can't see "now"). `name` is
 * trimmed-then-required so a whitespace-only name can't slip through. Strict,
 * like the event object: an unknown key is rejected, not dropped. */
const deferInputSchema = z
  .strictObject({
    name: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, {
        message: "defer.name is required — a short name for what you're watching",
      }),
    note: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, {
        message:
          "defer.note is required — why you are waiting, what to do on waking, and the links or ids it concerns",
      }),
    afterMinutes: z.number().int().min(1).optional(),
    at: z.string().optional(),
    event: deferEventSchema.optional(),
    chatId: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, { message: "defer.chatId must be non-empty" })
      .optional(),
  })
  .refine(
    (value) => [value.afterMinutes, value.at, value.event].filter((v) => v != null).length === 1,
    {
      message:
        'defer needs exactly one of "afterMinutes", "at" (an ISO 8601 instant) or "event" (an event to wait for)',
    },
  );

/** Validate the tool input. A time wakeup resolves to one absolute fire
 * instant, ceiled to the next whole minute (the schedule trigger is
 * minute-resolution) and in the future. An event wakeup resolves to the event
 * match. */
export function parseDeferInput(
  input: unknown,
  now: number,
  options: { taskChecks?: boolean } = {},
): ParsedDefer {
  // Only an agent whose policy checks tasks (the Concierge) links one.
  if (!options.taskChecks && input && typeof input === "object" && "chatId" in input) {
    return { ok: false, error: "defer.chatId is not available to this agent" };
  }
  const parsed = deferInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: "invalid defer input" };
    // Name where a structural error sits ("defer.event: Unrecognized key …");
    // the custom messages already start with their path.
    const where = ["defer", ...issue.path.map(String)].join(".");
    const error = issue.message.startsWith("defer") ? issue.message : `${where}: ${issue.message}`;
    return { ok: false, error };
  }
  const { name, note, afterMinutes, at, event, chatId } = parsed.data;
  const task = chatId ? { chatId } : {};

  if (event) {
    const { deadline, waitingFor, expiresInMs, ...match } = event;
    const consent = match.eventName === COMPUTER_CONSENT_EVENT;
    if (consent) {
      match.sourcePattern ??= COMPUTER_CONSENT_SOURCE;
    } else if (match.afterRevision !== undefined || expiresInMs !== undefined) {
      return {
        ok: false,
        error: "afterRevision and expiresInMs apply only to computer.consent.changed",
      };
    }
    if (!options.taskChecks && !consent) {
      return { ok: true, wakeUp: { kind: "event", name, note, event: match, ...task } };
    }
    if (options.taskChecks && !waitingFor) return { ok: false, error: WAITING_FOR_REQUIRED };
    let deadlineMs: number;
    if (deadline !== undefined) {
      deadlineMs = Date.parse(deadline);
      if (Number.isNaN(deadlineMs)) {
        return {
          ok: false,
          error: `defer.event.deadline "${deadline}" is not a valid ISO 8601 instant`,
        };
      }
    } else {
      if (!consent || expiresInMs === undefined) {
        if (options.taskChecks) return { ok: false, error: DEADLINE_REQUIRED };
        return { ok: false, error: "copy expiresInMs from the Computer Use request" };
      }
      // Give the last status read time to report the host's expiry.
      deadlineMs = new Date(now + expiresInMs + 5_000).getTime();
      if (Number.isNaN(deadlineMs))
        return { ok: false, error: "defer.event.expiresInMs exceeds the date range" };
    }
    if (consent) {
      const validated = validateConsentWatch(
        { type: "event-bus", once: true, ...match },
        { afterRevision: match.afterRevision, deadline: new Date(deadlineMs).toISOString() },
        { now },
      );
      if ("error" in validated) return { ok: false, error: validated.error };
    } else if (deadlineMs <= now) {
      return { ok: false, error: "defer.event.deadline is in the past — pick a later time" };
    }
    return {
      ok: true,
      wakeUp: { kind: "event", name, note, event: match, waitingFor, deadlineMs, ...task },
    };
  }

  let rawMs: number;
  if (afterMinutes != null) {
    rawMs = now + afterMinutes * MINUTE_MS;
  } else {
    // The refine above guarantees `at` is set when `afterMinutes` isn't.
    const parsedAt = Date.parse(at as string);
    if (Number.isNaN(parsedAt)) {
      return { ok: false, error: `defer.at "${at}" is not a valid ISO 8601 instant` };
    }
    rawMs = parsedAt;
  }

  // Minute floor: the schedule trigger is HH:mm. Ceil so we never
  // round down into the past, and so "fire in N minutes" never lands early.
  const fireAtMs = Math.ceil(rawMs / MINUTE_MS) * MINUTE_MS;
  if (fireAtMs <= now) {
    return { ok: false, error: "defer fires in the past — pick a time at least a minute from now" };
  }

  return { ok: true, wakeUp: { kind: "time", name, note, fireAtMs, ...task } };
}
