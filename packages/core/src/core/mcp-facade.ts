// Provider-neutral MCP tool facade. Agent model: docs/concepts/agents.md.
//
// Builds the action / subagent / skill tool surface every Rome provider must
// expose to the model. Each facade tool has:
//
//   - a JSON-schema input declaration (no SDK-flavored zod shapes)
//   - an MCP-standard handler returning `{ content: [{ type: "text", text }], isError? }`
//
// Adapters wrap these for whichever SDK the provider speaks:
//
//   - Anthropic side (`agent/infrastructure/model/anthropic/mcp-servers.ts`) wraps each into `tool()` +
//     `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`,
//     converting the JSON schema to a zod shape because that's what the SDK
//     accepts.
//   - Codex side (`codex/rome-dynamic-tools.ts`) flattens them into app-server
//     `dynamicTools` and calls the same handlers in process.
//
// The Anthropic MCP-server test (`anthropic/mcp-servers.test.ts`) is the
// regression gate for this module.

import { isValidTimeZone } from "../lib/timezone.js";
import { createLogger } from "../logger.js";
import type { ModelToolCallContext, RomeToolDefinition } from "./agent-runner.js";
import {
  askQuestionToolOutput,
  describeAction,
  MAX_SEARCH_LIMIT,
  normalizeAskQuestionForCard,
  SEARCH_LIMIT_DESCRIPTION,
  searchActions,
  searchSkills,
  showsWidgets,
  toActionSummary,
  toSkillSummary,
  type AgentAction,
  type DeferInput,
  type Skill,
} from "../agent/index.js";

const log = createLogger("mcp-facade");

export interface FacadeTextContent {
  type: "text";
  text: string;
}

export interface FacadeToolResult {
  content: FacadeTextContent[];
  isError?: boolean;
}

export type FacadeToolHandler = (
  input: Record<string, unknown>,
  context?: ModelToolCallContext,
) => Promise<FacadeToolResult>;

/** A Rome tool with the handler that runs it. */
export interface FacadeToolDef extends RomeToolDefinition {
  handler: FacadeToolHandler;
}

export interface FacadeBundle {
  /** Always four tools: list_actions, read_action, search_actions, execute_action. */
  actions: FacadeToolDef[];
  /** One tool per subagent declared in `subagentTools`. */
  subagents: FacadeToolDef[];
  /** Three tools when `skillCatalog` is non-empty, otherwise empty. */
  skills: FacadeToolDef[];
  /**
   * Built-in tools the model uses to ask the human something: `ask_question`
   * (registered on every surface — card in webchat, prose relay elsewhere) and
   * `propose_routine` (interactive surfaces only, no prose fallback). No side
   * effects; the conversational surface picks the tool_use event up out of band.
   */
  interactiveTools: FacadeToolDef[];
}

export interface FacadeParams {
  /**
   * Live getter consulted on every MCP request, so actions registered after
   * the bundle was built become visible without rebinding the MCP token. The
   * facade has no static-snapshot fallback — callers must always supply a
   * getter so a stale snapshot can't accidentally leak through.
   */
  getActionCatalog: () => AgentAction[];
  /**
   * Live getter consulted on every MCP request, so skills from apps installed
   * mid-session (via `app_management`) become discoverable without ending the
   * session. The skill tools always register; the getter may return `[]` for
   * agents that legitimately have no skills exposed.
   */
  getSkillCatalog: () => readonly Skill[];
  subagentTools: RomeToolDefinition[];
  executeAction: (name: string, input: unknown) => Promise<unknown>;
  executeSubagent: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>;
  /**
   * Whether the consuming surface can render interactive inline UI (cards, app
   * components) and will route the next user turn back to this session. The
   * webchat surface (dashboard + desktop) can; Telegram / Discord / CLI cannot.
   * `ask_question` registers either way (it relays prose off-webchat);
   * `propose_routine` has no prose fallback, so it registers only when true.
   */
  supportsInteractiveSurface?: boolean;
  /**
   * True when the interactive catalog must stay advertised but no surface
   * drains this session's stream to deliver UI — exact-mode forked turns,
   * whose tool catalog must stay byte-identical to their webchat source
   * (prefix identity) while nothing can mount cards.
   * Runtime behavior degrades honestly: `ask_question` relays prose (same as
   * a non-interactive surface); `propose_routine` returns an error instead of
   * claiming a card was delivered.
   */
  interactiveSurfaceDetached?: boolean;
  /**
   * Schedule a deferred self-wakeup (`defer`). When supplied, the
   * `defer` built-in registers on every surface; the implementation (captured
   * thread context, fire-time math, the one-off `create_routine`) lives in
   * core, so the facade just relays the call. Absent for sessions with no live
   * thread to wake (e.g. keyless validation runs).
   */
  executeDefer?: (input: DeferInput) => Promise<unknown>;
  /**
   * Tools this session alone carries, registered on every surface beside
   * `defer`. Their handlers own their own context.
   */
  sessionTools?: FacadeToolDef[];
  /**
   * Lets `propose_routine` with `activate: true` create the routine itself.
   * Absent → auto-enable is unavailable and the draft card is shown instead.
   */
  routineActivation?: RoutineActivationGate;
  /**
   * The agent's text never reaches the guardian, so `defer` does not ask it
   * to confirm in text: it could only confirm with another message.
   */
  textPrivate?: boolean;
}

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

function requireAction(actionCatalog: AgentAction[], actionName: string): AgentAction {
  const action = actionCatalog.find((entry) => entry.name === actionName);
  if (!action) {
    throw new Error(`Unknown action: ${actionName}`);
  }
  return action;
}

function assertJsonArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("execute_action.json_args must be an object");
  }
  return value as Record<string, unknown>;
}

function requireSkill(skillCatalog: readonly Skill[], skillName: string): Skill {
  const skill = skillCatalog.find((entry) => entry.name === skillName);
  if (!skill) {
    throw new Error(`Unknown skill: ${skillName}`);
  }
  return skill;
}

function resolveSkillLookupName(args: Record<string, unknown>): string {
  const skillName = typeof args.skill_name === "string" ? args.skill_name : args.query;
  if (typeof skillName !== "string" || skillName.trim() === "") {
    throw new Error('Missing skill name. Provide "skill_name" with the exact skill name.');
  }
  return skillName;
}

// Handler wrapper — the standard try / serialize / wrap-in-text envelope
// every facade tool uses. Result shape matches the MCP `CallToolResult`
// standard exactly.

export async function runFacadeTool(
  toolName: string,
  input: unknown,
  handler: (args: Record<string, unknown>) => Promise<unknown>,
): Promise<FacadeToolResult> {
  try {
    const args = (input ?? {}) as Record<string, unknown>;
    log.info("executing facade tool", { tool: toolName });
    const output = await handler(args);
    const resultStr = typeof output === "string" ? output : JSON.stringify(output);
    return { content: [{ type: "text", text: resultStr }] };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error("facade tool execution failed", { tool: toolName, error: errorMsg });
    return {
      content: [{ type: "text", text: errorMsg }],
      isError: true,
    };
  }
}

// JSON schemas are written out explicitly because adapters need them
// (Anthropic converts to zod; HTTP MCP serves as-is).

function buildActionFacadeTools(
  getActionCatalog: () => AgentAction[],
  executeAction: (name: string, input: unknown) => Promise<unknown>,
): FacadeToolDef[] {
  return [
    {
      name: "list_actions",
      description: "List the actions available to this agent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: (input) =>
        runFacadeTool("list_actions", input, async () =>
          [...getActionCatalog()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(toActionSummary),
        ),
    },
    {
      name: "read_action",
      description: "Read one available action and its arguments.",
      inputSchema: {
        type: "object",
        properties: {
          action_name: { type: "string", description: "The action name to inspect." },
        },
        required: ["action_name"],
        additionalProperties: false,
      },
      handler: (input) =>
        runFacadeTool("read_action", input, async (args) =>
          describeAction(requireAction(getActionCatalog(), String(args.action_name))),
        ),
    },
    {
      name: "search_actions",
      description:
        "Search available actions by regex against name, description, or argument guidance. Supports /pattern/flags for explicit flags.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Regex pattern to match actions, or /pattern/flags for explicit flags.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            description: SEARCH_LIMIT_DESCRIPTION,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: (input) =>
        runFacadeTool("search_actions", input, async (args) =>
          searchActions(
            getActionCatalog(),
            String(args.query ?? ""),
            typeof args.limit === "number" ? args.limit : undefined,
          ),
        ),
    },
    {
      name: "execute_action",
      description: "Execute one available action with object arguments in json_args.",
      inputSchema: {
        type: "object",
        properties: {
          action_name: { type: "string", description: "The action name to execute." },
          json_args: {
            type: "object",
            description: "Object arguments to pass to the action.",
            additionalProperties: true,
          },
        },
        required: ["action_name", "json_args"],
        additionalProperties: false,
      },
      handler: (input) =>
        runFacadeTool("execute_action", input, async (args) => {
          const actionName = String(args.action_name);
          const parsedArgs = assertJsonArgs(args.json_args);
          log.info("executing action via MCP facade", {
            tool: "execute_action",
            action: actionName,
          });
          // executeAction does the live allow-list-filtered lookup and throws
          // "Unknown action: <name>" if it's not visible — no catalog walk here.
          return executeAction(actionName, parsedArgs);
        }),
    },
  ];
}

function buildSubagentFacadeTools(
  subagentTools: RomeToolDefinition[],
  executeSubagent: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>,
): FacadeToolDef[] {
  return subagentTools.map((toolDef) => ({
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    handler: (input, context) =>
      runFacadeTool(toolDef.name, input, (parsed) => {
        if (!context?.toolUseId) {
          throw new Error(`Subagent tool "${toolDef.name}" is missing its tool-use identity`);
        }
        return executeSubagent(toolDef.name, parsed, context);
      }),
  }));
}

function buildSkillFacadeTools(getSkillCatalog: () => readonly Skill[]): FacadeToolDef[] {
  return [
    {
      name: "list_skills",
      description: "List the skills available in this workspace.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: (input) =>
        runFacadeTool("list_skills", input, async () =>
          [...getSkillCatalog()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(toSkillSummary),
        ),
    },
    {
      name: "search_skills",
      description:
        "Search available skills by regex against name, description, or declared tools. Supports /pattern/flags for explicit flags.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Regex pattern to match skills, for example browser|calendar, or /web(fetch|search)/i for explicit flags.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            description: SEARCH_LIMIT_DESCRIPTION,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: (input) =>
        runFacadeTool("search_skills", input, async (args) =>
          searchSkills(
            getSkillCatalog(),
            String(args.query ?? ""),
            typeof args.limit === "number" ? args.limit : undefined,
          ),
        ),
    },
    {
      name: "read_skill",
      description:
        "Read the full markdown for one available skill. When the skill ships companion files, the result also returns its `directory` and `files`; open one with your file tools only when the skill body points you to it.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill name to read." },
          query: { type: "string", description: "Alias for skill_name. Use the exact skill name." },
        },
        additionalProperties: false,
      },
      handler: (input) =>
        runFacadeTool("read_skill", input, async (args) => {
          const skillName = resolveSkillLookupName(args);
          const skill = requireSkill(getSkillCatalog(), skillName);
          return {
            name: skillName,
            content: skill.content,
            ...(skill.directory && skill.files?.length
              ? { directory: skill.directory, files: skill.files }
              : {}),
          };
        }),
    },
  ];
}

export function buildFacadeBundle(params: FacadeParams): FacadeBundle {
  return {
    actions: buildActionFacadeTools(params.getActionCatalog, params.executeAction),
    subagents: buildSubagentFacadeTools(params.subagentTools, params.executeSubagent),
    skills: buildSkillFacadeTools(params.getSkillCatalog),
    interactiveTools: buildInteractiveTools(
      params.supportsInteractiveSurface ?? false,
      params.interactiveSurfaceDetached ?? false,
      params.executeDefer,
      params.routineActivation
        ? { ...params.routineActivation, executeAction: params.executeAction }
        : undefined,
      params.sessionTools,
      params.textPrivate ?? false,
    ),
  };
}

// Interactive UI tools — provider-agnostic built-ins that hand an interactive
// element back to the human. The conversational surface renders it off the
// model's tool_use event; the tool itself just validates input and tells the
// model to wait for the next turn.

const PROPOSE_ROUTINE_DIRECTIVE =
  "The routine draft card has been delivered to the user. They turn it on themselves via the card — it creates the routine directly, so do NOT call any create action yourself. Reply with one short line confirming what you've drafted, then end your turn.";

type ActivationDeps = RoutineActivationGate & {
  executeAction: (name: string, input: unknown) => Promise<unknown>;
};

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
  draft: import("@rome-os/app-runtime").RoutineDraftSpec,
  toolUseId: string | undefined,
  deps: ActivationDeps | undefined,
): Promise<FacadeToolResult> {
  const text = (t: string, isError?: true): FacadeToolResult => ({
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

  if (!deps) return fallback("auto-enable is not available in this session");
  const routineKey = toolUseId ? deps.routineKeyFor(toolUseId) : undefined;
  if (!routineKey) return fallback("this tool call has no id to key the routine by");
  const target = deps.canCallAction(draft.actionName);
  if (target === "unknown") {
    return text(
      `actionName "${draft.actionName}" is not a registered action, so no routine was created and no card was shown. Bind the routine to an existing action.`,
      true,
    );
  }
  if (target === "denied") {
    return fallback(`"${draft.actionName}" is not an action you are permitted to call`);
  }
  if (deps.canCallAction(CREATE_ROUTINE_ACTION) !== "permitted") {
    return fallback("you are not permitted to create routines directly");
  }

  // create_routine runs the same args check. This copy runs in-process against
  // the session's registry, so a draft with bad args is rejected without
  // starting a create_routine execution that would only record a failure.
  const argsError = deps.validateArgs(draft.actionName, draft.args);
  if (argsError) {
    return text(
      `The routine was NOT created and no card was shown: ${argsError}. Fix the args and call propose_routine again.`,
      true,
    );
  }

  let result: unknown;
  try {
    result = await deps.executeAction(CREATE_ROUTINE_ACTION, {
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
  const r = (result ?? {}) as { status?: unknown; error?: unknown; routineId?: unknown };
  // The key is this call's own, so "already exists" means its routine was saved
  // (e.g. the card's Turn it on won a race after a stopped turn). The wording is
  // pinned by create_routine's duplicate-key test.
  if (r.status === "error" && typeof r.error === "string" && /already exists/.test(r.error)) {
    return uncertain(r.error);
  }
  if (r.status === "error" || typeof r.routineId !== "string") {
    const error = typeof r.error === "string" ? r.error : "create_routine returned no routineId";
    return text(
      `The routine was NOT created and no card was shown: ${error}. Fix the input and call propose_routine again.`,
      true,
    );
  }
  return text(
    `Routine "${draft.name}" is on (id ${r.routineId}). The guardian can pause or delete it from the Routines page. Do NOT call any create action. Reply with one short line confirming what is now scheduled, then end your turn.`,
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

const DEFER_DESCRIPTION =
  "Schedule a wake-up later in THIS SAME conversation, with full context intact — use it when you're " +
  "watching something that isn't ready yet (a CI run, a build, a reply) instead of ending the turn empty. " +
  "Give a short `name` for what you're watching (it becomes the routine's name) and exactly one of " +
  "`afterMinutes`, `at`, or `event`. Prefer `event` when something announces completion (CI finished, a PR " +
  "merged, a reply): it wakes as soon as a matching event-bus event is published, once, on the first match, " +
  "with no timeout. Look up the event name and payload fields with the search_event_catalog action first. " +
  "For a `subscribable` type, filter on one of its `keys` (e.g. repository.full_name); defer then subscribes " +
  "at the provider and fails with the reason if it can't. Events are not replayed and a new subscription " +
  "only sees future events: after an event defer, check the current state once more, and if what you're " +
  "waiting for already happened, handle it now. When you wake you're pinged back in this thread with the whole conversation still in context, so " +
  "just re-evaluate and either finish or `defer` again (minimum one minute, no limit on re-defers). ";

const DEFER_END_OF_TURN =
  "After calling defer, write one short line confirming you'll keep watch, then end your turn.";
const DEFER_END_OF_TURN_TEXT_PRIVATE =
  "After calling defer, end your turn. It needs no confirmation.";

function buildDeferFacadeTool(
  executeDefer: (input: DeferInput) => Promise<unknown>,
  textPrivate: boolean,
): FacadeToolDef {
  return {
    name: "defer",
    description:
      DEFER_DESCRIPTION + (textPrivate ? DEFER_END_OF_TURN_TEXT_PRIVATE : DEFER_END_OF_TURN),
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description:
            'A short name for what you\'re watching, e.g. "GitHub CI run" or "Dana\'s reply". Stored as the ' +
            "routine's name and shown on the Routines page; you'll be pinged back in this same conversation when the time is up.",
        },
        afterMinutes: {
          type: "integer",
          minimum: 1,
          description:
            "Minutes from now until wakeup, e.g. 5 (five minutes) or 120 (two hours). Minimum 1. Provide exactly one of afterMinutes, at, or event.",
        },
        at: {
          type: "string",
          description:
            "Absolute wakeup time as an ISO 8601 instant, e.g. 2026-06-25T14:30:00Z. Provide exactly one of afterMinutes, at, or event.",
        },
        event: {
          type: "object",
          description:
            "Wake on the next event-bus event that matches. Provide exactly one of afterMinutes, at, or event.",
          required: ["eventName"],
          properties: {
            eventName: {
              type: "string",
              description:
                "The exact event type, from search_event_catalog, e.g. provider:event:github.workflow_run.",
            },
            sourcePattern: {
              type: "string",
              description:
                "Optional: only match events from this source (an appId); a single * matches any run of characters.",
            },
            filter: {
              type: "array",
              description:
                "Optional payload conditions, AND-ed together. Each compares the payload value at a dot-path, as a string, for equality.",
              items: {
                type: "object",
                required: ["field", "equals"],
                properties: {
                  field: {
                    type: "string",
                    description: "Dot-path into the payload, e.g. pull_request.number",
                  },
                  equals: { type: "string", description: "Value the field must equal" },
                },
              },
            },
          },
        },
      },
    },
    // The MCP layer has already validated `input` against this tool's advertised
    // JSON schema (see `toMcpToolShape`), so the cast to the typed shape is safe;
    // `runDefer` still enforces the value-level rules the schema can't express.
    handler: (input) => runFacadeTool("defer", input, () => executeDefer(input as DeferInput)),
  };
}

function buildInteractiveTools(
  supportsInteractiveSurface: boolean,
  interactiveSurfaceDetached: boolean,
  executeDefer?: (input: DeferInput) => Promise<unknown>,
  activation?: ActivationDeps,
  sessionTools: FacadeToolDef[] = [],
  textPrivate = false,
): FacadeToolDef[] {
  const widgetsShow = showsWidgets(
    supportsInteractiveSurface ? "card" : "plain_text",
    !interactiveSurfaceDetached,
  );
  // `ask_question` is registered on every surface: webchat mounts the card; other
  // surfaces (messaging channels, subagents, CLI) get the questions relayed as
  // prose from the handler, so the model routes clarifying questions through it
  // regardless of surface. `propose_routine` has no prose
  // fallback, so it stays interactive-only (appended below).
  const tools: FacadeToolDef[] = [
    {
      name: "ask_question",
      // On a card the turn parks until the guardian answers; the plain-message
      // relay returns and the turn goes on.
      endsTurn: widgetsShow,
      description:
        "Ask the guardian one or more clarifying questions (single-choice, multi-choice, or short free-text), rendered as an interactive card in web chat or relayed as a plain message on other surfaces. Use it only when the answer would significantly change the direction of the work; otherwise proceed with your recommended approach and state your assumptions. When you do ask, use this tool rather than writing the questions in your text reply. Each call collects one set of questions, and the guardian's answers come back as the next turn. Prefer single-choice questions with concrete options when the likely answers are enumerable (set freeText so they can still type their own); use multi when several answers can apply at once.",
      inputSchema: {
        type: "object",
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            description: "Questions rendered together as one card.",
            items: {
              type: "object",
              required: ["id", "question", "type"],
              properties: {
                id: {
                  type: "string",
                  description: "Stable id; the answer references it.",
                },
                question: {
                  type: "string",
                  description: "The prompt shown to the guardian.",
                },
                type: {
                  type: "string",
                  enum: ["single", "multi", "text"],
                  description:
                    "single: pick exactly one option; multi: pick any number of options; text: free-form.",
                },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description: "Required for single and multi; the choices. Ignored for text.",
                },
                freeText: {
                  type: "boolean",
                  description:
                    "single/multi only: also show a free-text box beneath the options, so the guardian can tap option(s) OR type their own answer. Use this for most choice questions — it keeps input cheap (a tap) without trapping them in your option set. Ignored for text.",
                },
                optional: {
                  type: "boolean",
                  description:
                    "If true, the guardian may leave this question blank without blocking submit (a blank answer is simply omitted from the results). Defaults to false — questions are required.",
                },
              },
            },
          },
        },
      },
      handler: async (input) => {
        const result = normalizeAskQuestionForCard(input);
        if (!result.ok) {
          return { content: [{ type: "text", text: result.error }], isError: true };
        }
        const output = askQuestionToolOutput(result.questions, widgetsShow);
        const text = typeof output === "string" ? output : JSON.stringify(output);
        return { content: [{ type: "text", text }] };
      },
    },
  ];
  // `defer` registers on every surface that has a live thread to wake
  // — it injects an inbound message rather than rendering UI, so it needs no
  // interactive surface. Only absent when the session has no defer impl wired.
  if (executeDefer) {
    tools.push(buildDeferFacadeTool(executeDefer, textPrivate));
  }
  tools.push(...sessionTools);
  // propose_routine renders UI and has no prose fallback, so keep it on
  // interactive surfaces only. Detached sessions (exact forks) keep advertising
  // it — the catalog must stay byte-identical to the source — but its handler
  // refuses at runtime instead of claiming UI was delivered.
  if (!supportsInteractiveSurface) return tools;
  tools.push({
    name: "propose_routine",
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
      // No drain to render the card on a detached session (exact fork) — the
      // directive below would falsely claim it was delivered.
      if (interactiveSurfaceDetached) {
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
        return activateRoutineDraft(result.draft, context?.toolUseId, activation);
      }
      return { content: [{ type: "text", text: PROPOSE_ROUTINE_DIRECTIVE }] };
    },
  });
  return tools;
}
