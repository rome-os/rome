// `propose_routine`: the tool that offers the guardian a routine on a card, and
// the draft rules behind it. A session carries it where the place draws cards.

import type { ActionResult, RoutineDraftSpec } from "@rome-os/app-runtime";
import {
  ROUTINE_PROPOSAL_TOOL,
  type RomeTool,
  type RomeToolResult,
  type WidgetDrawing,
} from "../agent/index.js";
import { isValidTimeZone } from "../lib/timezone.js";

/** What `propose_routine` checks before it creates a routine without the
 * guardian's click. */
export interface RoutineActivationGate {
  /** Whether this session's agent may call `name` itself — the same allow-list
   * check `executeAction` enforces. Auto-enable needs both `create_routine` and
   * the target action, so it never schedules anything the agent couldn't
   * already schedule by calling `create_routine` directly. */
  canCallAction(name: string): "permitted" | "denied" | "unknown";
  /** The target action's input-schema check on the routine's args — the same
   * one `POST /api/routines` runs for the card's "Turn it on". Null when the
   * args fit. */
  validateArgs(actionName: string, args: Record<string, unknown>): string | null;
  /** The key to create this tool call's routine with — derived from the
   * current Rome turn, the same way the webchat drain derives the card's key.
   * Undefined when no turn is running. */
  routineKeyFor(toolUseId: string): string | undefined;
}

const PROPOSE_ROUTINE_DIRECTIVE =
  "The routine draft card has been delivered to the user. They turn it on themselves via the card — it creates the routine directly, so do NOT call any create action yourself. Reply with one short line confirming what you've drafted, then end your turn.";

const CREATE_ROUTINE_ACTION = "create_routine";

/** Create the drafted routine enabled, on the guardian's explicit instruction.
 * The routine goes through the agent's own `create_routine` call (same
 * allow-list, validation and attribution as a direct call); the target must be
 * an action the agent may call too. Without that permission, it falls back to
 * the draft card, so the guardian's click stays the gate.
 *
 * The routine's key comes from the turn and the tool call (`routineKeyFor`), so
 * the webchat drain derives the card's key on its own and never takes a
 * routine identity from the tool's output. A non-error result means "show a
 * card"; whether that card is On or a draft is settled by the card's lookup. */
async function activateRoutineDraft(
  draft: RoutineDraftSpec,
  toolUseId: string | undefined,
  gate: RoutineActivationGate,
  runAction: (name: string, input: unknown) => Promise<ActionResult>,
): Promise<RomeToolResult> {
  const text = (t: string, isError?: true): RomeToolResult => ({
    content: [{ type: "text", text: t }],
    ...(isError ? { isError } : {}),
  });
  const uncertain = (detail: string) =>
    text(
      `create_routine did not confirm the routine (${detail}), so it may or may not exist. Its card was shown and reflects what was saved — do NOT call propose_routine or any create action again. Tell the guardian to check the card, then end your turn.`,
    );
  const fallback = (reason: string) =>
    text(
      `Not turned on automatically: ${reason}. A draft card was shown instead — the guardian turns it on themselves, so do NOT call any create action. Reply with one short line saying the routine is drafted and needs their click, then end your turn.`,
    );

  const routineKey = toolUseId ? gate.routineKeyFor(toolUseId) : undefined;
  if (!routineKey) return fallback("this tool call has no id to key the routine by");
  const target = gate.canCallAction(draft.actionName);
  if (target === "unknown") {
    return text(
      `actionName "${draft.actionName}" is not a registered action, so no routine was created and no card was shown. Bind the routine to an existing action.`,
      true,
    );
  }
  if (target === "denied") {
    return fallback(`"${draft.actionName}" is not an action you are permitted to call`);
  }
  if (gate.canCallAction(CREATE_ROUTINE_ACTION) !== "permitted") {
    return fallback("you are not permitted to create routines directly");
  }

  // create_routine runs the same args check. This copy runs in-process against
  // the session's registry, so a draft with bad args is rejected without
  // starting a create_routine execution that would only record a failure.
  const argsError = gate.validateArgs(draft.actionName, draft.args);
  if (argsError) {
    return text(
      `The routine was NOT created and no card was shown: ${argsError}. Fix the args and call propose_routine again.`,
      true,
    );
  }

  let result: ActionResult;
  try {
    result = await runAction(CREATE_ROUTINE_ACTION, {
      key: routineKey,
      name: draft.name,
      trigger: draft.trigger,
      actionName: draft.actionName,
      args: draft.args,
    });
  } catch (err) {
    // A throw (an RPC failure, an aborted turn) doesn't say whether the row
    // was saved. Don't report "not created": the agent would retry under a new
    // key and could leave a second live routine. Show the card instead; its
    // lookup by key shows whether the routine exists.
    return uncertain(err instanceof Error ? err.message : String(err));
  }
  // The key is this call's own, so "already exists" means its routine was saved
  // (e.g. the card's Turn it on won a race after a stopped turn). The wording is
  // pinned by create_routine's duplicate-key test.
  if (result.status === "error" && /already exists/.test(result.error)) {
    return uncertain(result.error);
  }
  const routineId =
    result.status === "ok" ? (result.data as { routineId?: unknown } | undefined)?.routineId : null;
  if (typeof routineId !== "string") {
    const error = result.status === "error" ? result.error : "create_routine returned no routineId";
    return text(
      `The routine was NOT created and no card was shown: ${error}. Fix the input and call propose_routine again.`,
      true,
    );
  }
  return text(
    `Routine "${draft.name}" is on (id ${routineId}). The guardian can pause or delete it from the Routines page. Do NOT call any create action. Reply with one short line confirming what is now scheduled, then end your turn.`,
  );
}

/** Validate and shape a `propose_routine` tool input into the card's draft
 * payload. Fails closed so a malformed draft never renders a card that would
 * create a broken routine on confirm. */
export function normalizeRoutineDraftForCard(
  input: unknown,
):
  | { ok: true; draft: import("@rome-os/app-runtime").RoutineDraftSpec }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "propose_routine input must be an object" };
  }
  const o = input as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof o[k] === "string" && o[k] ? (o[k] as string) : null;

  const sentence = str("sentence");
  const name = str("name");
  const watchLabel = str("watchLabel");
  const thenSummary = str("thenSummary");
  const actionName = str("actionName");
  for (const [label, value] of [
    ["sentence", sentence],
    ["name", name],
    ["watchLabel", watchLabel],
    ["thenSummary", thenSummary],
    ["actionName", actionName],
  ] as const) {
    if (!value)
      return {
        ok: false,
        error: `propose_routine.${label} is required and must be a non-empty string`,
      };
  }

  if (!o.args || typeof o.args !== "object" || Array.isArray(o.args)) {
    return { ok: false, error: "propose_routine.args must be a single object" };
  }

  if (o.kind !== "event" && o.kind !== "schedule" && o.kind !== "manual") {
    return { ok: false, error: 'propose_routine.kind must be "event", "schedule", or "manual"' };
  }

  const triggerResult =
    o.kind === "event"
      ? buildEventTriggerFromInput(o)
      : o.kind === "schedule"
        ? buildScheduleTriggerFromInput(o)
        : buildManualTriggerFromInput();
  if (!triggerResult.ok) return triggerResult;

  return {
    ok: true,
    draft: {
      sentence: sentence!,
      name: name!,
      watchLabel: watchLabel!,
      // Schedule triggers carry no payload filter; only event drafts show one.
      filterSummary: o.kind === "event" ? (str("filterSummary") ?? undefined) : undefined,
      thenSummary: thenSummary!,
      trigger: triggerResult.trigger,
      actionName: actionName!,
      args: o.args as Record<string, unknown>,
    },
  };
}

type EventBusTriggerT = import("@rome-os/app-runtime").EventBusTrigger;
type ScheduleTriggerT = import("@rome-os/app-runtime").ScheduleTrigger;
type ManualTriggerT = import("@rome-os/app-runtime").ManualTrigger;

/** A manual routine carries no trigger config — it never fires on its own and
 * only runs from the dashboard's "Run now" button. The card still confirms the
 * draft (name, what it does) so the guardian deliberately saves it. */
function buildManualTriggerFromInput(): { ok: true; trigger: ManualTriggerT } {
  return { ok: true, trigger: { type: "manual" } };
}

function buildEventTriggerFromInput(
  o: Record<string, unknown>,
): { ok: true; trigger: EventBusTriggerT } | { ok: false; error: string } {
  const eventName = typeof o.eventName === "string" && o.eventName ? o.eventName : null;
  if (!eventName) {
    return {
      ok: false,
      error: "propose_routine.eventName is required for an event routine (kind: event)",
    };
  }

  const filter: { field: string; equals: string }[] = [];
  if (o.filter !== undefined) {
    if (!Array.isArray(o.filter)) {
      return { ok: false, error: "propose_routine.filter must be an array of {field, equals}" };
    }
    for (const c of o.filter) {
      const f = c as Record<string, unknown>;
      if (typeof f?.field !== "string" || !f.field.trim() || typeof f?.equals !== "string") {
        return {
          ok: false,
          error:
            "each propose_routine.filter condition needs a non-empty field and a string equals",
        };
      }
      filter.push({ field: f.field, equals: f.equals });
    }
  }

  const trigger: EventBusTriggerT = { type: "event-bus", eventName };
  if (filter.length > 0) trigger.filter = filter;
  return { ok: true, trigger };
}

/** Validate the schedule fields the same way the `create_routine` action does,
 * so a confirm card never creates a silently-dead schedule (bad HH:mm, unknown
 * timezone, or a MONTHLY rule with no day-of-month). */
function buildScheduleTriggerFromInput(
  o: Record<string, unknown>,
): { ok: true; trigger: ScheduleTriggerT } | { ok: false; error: string } {
  const tzid = typeof o.tzid === "string" && o.tzid.trim() ? o.tzid.trim() : null;
  const localTime =
    typeof o.localTime === "string" && o.localTime.trim() ? o.localTime.trim() : null;
  if (!tzid || !localTime) {
    return {
      ok: false,
      error:
        "propose_routine.tzid and propose_routine.localTime are required for a schedule routine (kind: schedule)",
    };
  }
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    return {
      ok: false,
      error: `propose_routine.localTime "${localTime}" is invalid — expected HH:mm (24-hour), e.g. 09:30`,
    };
  }
  if (!isValidTimeZone(tzid)) {
    return { ok: false, error: `propose_routine.tzid "${tzid}" is not a valid IANA timezone` };
  }

  const rrule = typeof o.rrule === "string" && o.rrule.trim() ? o.rrule.trim() : undefined;
  const date = typeof o.date === "string" && o.date.trim() ? o.date.trim() : undefined;
  if (rrule && date) {
    return {
      ok: false,
      error: "propose_routine: set either rrule (recurring) or date (one-off), not both",
    };
  }
  if (rrule && rrule.toUpperCase().includes("FREQ=MONTHLY") && !/BYMONTHDAY=/i.test(rrule)) {
    return {
      ok: false,
      error:
        "propose_routine.rrule FREQ=MONTHLY requires BYMONTHDAY=N, e.g. FREQ=MONTHLY;BYMONTHDAY=1",
    };
  }

  // Binding. A dated one-off is an absolute instant → always pinned
  // (`fixed`). For a recurring schedule the caller chooses: `floating` (default,
  // follows the guardian's local time) or `fixed` for a zone-anchored routine
  // (e.g. a market open at 09:30 Asia/Tokyo every weekday).
  const requestedMode = o.tzMode;
  if (requestedMode !== undefined && requestedMode !== "fixed" && requestedMode !== "floating") {
    return { ok: false, error: 'propose_routine.tzMode must be "fixed" or "floating"' };
  }
  const tzMode: "fixed" | "floating" = date
    ? "fixed"
    : ((requestedMode as "fixed" | "floating" | undefined) ?? "floating");

  const trigger: ScheduleTriggerT = { type: "schedule", tzid, tzMode, localTime };
  if (rrule) trigger.rrule = rrule;
  if (date) trigger.date = date;
  return { ok: true, trigger };
}

/**
 * Empty unless the place draws cards, because `propose_routine` has no
 * plain-text form. A session with no speaker keeps the tool, so a fork's catalog
 * matches its source, and the handler refuses.
 */
export function proposeRoutineTools(input: {
  widgets: WidgetDrawing;
  hasSpeaker: boolean;
  gate: RoutineActivationGate;
  /** Returns the raw result, so activation reads `data.routineId`, not a shaped output. */
  runAction: (name: string, input: unknown) => Promise<ActionResult>;
}): RomeTool[] {
  if (input.widgets !== "card") return [];
  const { hasSpeaker, gate, runAction } = input;
  return [
    {
      name: ROUTINE_PROPOSAL_TOOL,
      description:
        "Propose a routine (an automation) to the user as an interactive confirm card in web chat. A routine fires one of three ways: when a matching event arrives (kind: event), on a schedule (kind: schedule), or never on its own — a saved playbook the guardian runs by hand from the Routines page's 'Run now' button (kind: manual). Use this — never create the routine silently — once you've gathered enough detail (the trigger, any narrowing, what to do). By default the card is a draft with a 'Turn it on' button that creates the routine directly; you do not call any create action afterwards. Set activate: true only when the guardian explicitly asked for this exact routine; the card then shows it already on. Gather missing detail first with the ask_question action. For event routines, discover the exact event type with search_event_catalog rather than guessing.",
      inputSchema: {
        type: "object",
        required: ["sentence", "name", "watchLabel", "thenSummary", "kind", "actionName", "args"],
        properties: {
          sentence: {
            type: "string",
            description:
              'One-line headline in plain language, e.g. "When you get an email from Dana, Rome will summarize it and text you." or "Every Friday at 9am, Rome will send you a week-ahead summary."',
          },
          name: {
            type: "string",
            description: 'Short stored routine name, e.g. "Landlord emails".',
          },
          watchLabel: {
            type: "string",
            description:
              'What triggers it, in human terms: "Gmail · new email" (event), "Every Friday at 9:00 AM" (schedule), or "Run on demand" (manual).',
          },
          filterSummary: {
            type: "string",
            description:
              'Event routines only: optional plain-language narrowing, e.g. "sender is dana@example.com". Omit when the routine watches every event of this type, or for schedule routines.',
          },
          thenSummary: {
            type: "string",
            description:
              'What Rome does when it fires, e.g. "summarize it and text you on Telegram".',
          },
          kind: {
            type: "string",
            enum: ["event", "schedule", "manual"],
            description:
              '"event" when the routine should fire on something happening (an email arrives, a payment lands); "schedule" when it should fire at a time or on a recurring cadence ("every Friday at 9am", "tomorrow at noon"); "manual" when it should never fire on its own — a saved playbook the guardian keeps and runs by hand from the Routines page ("save this as something I can run whenever I want"). Manual routines need no eventName/tzid/schedule fields.',
          },
          eventName: {
            type: "string",
            description:
              'Event routines (kind: event) only — required there. The exact bus event type to watch, from search_event_catalog, e.g. "provider:event:gmail.gmail_new_gmail_message".',
          },
          filter: {
            type: "array",
            description:
              "Event routines only: optional payload conditions, AND-ed together. Omit to fire on every event of this type.",
            items: {
              type: "object",
              required: ["field", "equals"],
              properties: {
                field: {
                  type: "string",
                  description: "Dot-path into the event payload, e.g. from.email",
                },
                equals: { type: "string", description: "Value the payload at `field` must equal" },
              },
            },
          },
          tzid: {
            type: "string",
            description:
              'Schedule routines (kind: schedule) only — required there. IANA timezone for the time, e.g. "America/Los_Angeles". Infer from what the guardian tells you; do not make them type an IANA name.',
          },
          tzMode: {
            type: "string",
            enum: ["fixed", "floating"],
            description:
              "Schedule routines only. How the timezone is bound. Omit (defaults to 'floating') for an ordinary reminder — it follows the guardian and fires at localTime wherever they are. Use 'fixed' only for a zone-anchored recurring routine that must stay pinned to tzid no matter where the guardian goes (e.g. a market open at 09:30 Asia/Tokyo). One-offs are always pinned regardless.",
          },
          localTime: {
            type: "string",
            description:
              'Schedule routines only — required there. Time of day in 24-hour HH:mm, e.g. "09:00" or "17:30".',
          },
          rrule: {
            type: "string",
            description:
              'Schedule routines only: iCal RRULE for a recurring schedule, e.g. "FREQ=WEEKLY;BYDAY=FR" or "FREQ=DAILY". Omit for a one-off. Mutually exclusive with date.',
          },
          date: {
            type: "string",
            description:
              'Schedule routines only: calendar date "YYYY-MM-DD" for a true one-off. Omit for recurring or for "next time it is localTime". Mutually exclusive with rrule.',
          },
          actionName: {
            type: "string",
            description: "The action the routine fires when it triggers, e.g. send_message.",
          },
          args: {
            type: "object",
            description: "A single argument object for the action. Not an array.",
            additionalProperties: true,
          },
          activate: {
            type: "boolean",
            description:
              "Create the routine enabled right away instead of waiting for the guardian's click. Use only when the guardian explicitly stated the trigger or cadence, what to run and its arguments — nothing you inferred — and it acts on their behalf (sending, posting, spending) only as they asked. Otherwise omit it. Falls back to a draft card if you may not call the action yourself.",
          },
        },
      },
      handler: async (input, context) => {
        const result = normalizeRoutineDraftForCard(input);
        if (!result.ok) {
          return { content: [{ type: "text", text: result.error }], isError: true };
        }
        // With no speaker nothing mounts the card, and the directive below would
        // falsely claim it was delivered.
        if (!hasSpeaker) {
          return {
            content: [
              {
                type: "text",
                text: "This turn runs detached from the interactive surface, so the routine card was NOT shown to the guardian. Continue without proposing a routine; describe it in prose instead if useful.",
              },
            ],
            isError: true,
          };
        }
        if (input.activate === true) {
          return activateRoutineDraft(result.draft, context?.toolUseId, gate, runAction);
        }
        return { content: [{ type: "text", text: PROPOSE_ROUTINE_DIRECTIVE }] };
      },
    },
  ];
}
