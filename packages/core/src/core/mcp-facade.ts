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
//   - Anthropic side (`anthropic-mcp-servers.ts`) wraps each into `tool()` +
//     `createSdkMcpServer()` from `@anthropic-ai/claude-agent-sdk`,
//     converting the JSON schema to a zod shape because that's what the SDK
//     accepts.
//   - Codex side (`codex/rome-dynamic-tools.ts`) flattens them into app-server
//     `dynamicTools` and calls the same handlers in process.
//
// The Anthropic MCP-server test (`anthropic-mcp-servers.test.ts`) is the
// regression gate for this module.

import { createLogger } from "../logger.js";
import type { DeferInput } from "./defer.js";
import type {
  ActionMcpDefinition,
  ModelToolCallContext,
  ModelToolDefinition,
  SkillMcpDefinition,
  HandbackSpec,
} from "./agent-runner.js";

export type { HandbackSpec };

const log = createLogger("mcp-facade");

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const SEARCH_LIMIT_DESCRIPTION =
  `Optional. Recommended: omit this parameter to use the default of ${DEFAULT_SEARCH_LIMIT}. ` +
  `If provided, use an integer from 1 to ${MAX_SEARCH_LIMIT}.`;

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

export interface FacadeToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. Adapters translate as needed. */
  inputSchema: Record<string, unknown>;
  handler: FacadeToolHandler;
}

export interface FacadeBundle {
  /** Always four tools: list_actions, read_action, search_actions, execute_action. */
  actions: FacadeToolDef[];
  /** One tool per subagent declared in `subagentTools`. */
  subagents: FacadeToolDef[];
  /** Three tools when `skillCatalog` is non-empty, otherwise empty. */
  skills: FacadeToolDef[];
  /** One `submit_output` tool for conversational handback sessions. */
  submitOutput: FacadeToolDef[];
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
  getActionCatalog: () => ActionMcpDefinition[];
  /**
   * Live getter consulted on every MCP request, so skills from apps installed
   * mid-session (via `app_management`) become discoverable without ending the
   * session. The skill tools always register; the getter may return `[]` for
   * agents that legitimately have no skills exposed.
   */
  getSkillCatalog: () => SkillMcpDefinition[];
  subagentTools: ModelToolDefinition[];
  handback?: HandbackSpec;
  executeAction: (name: string, input: unknown) => Promise<unknown>;
  executeSubagent: (
    name: string,
    input: unknown,
    context: ModelToolCallContext,
  ) => Promise<unknown>;
  executeSubmitOutput?: (input: unknown) => Promise<unknown>;
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
   * (prefix identity) while nothing can mount cards or resolve handbacks.
   * Runtime behavior degrades honestly: `ask_question` relays prose (same as
   * a non-interactive surface); `propose_routine` and `confirm_output` return
   * an error instead of claiming a card was delivered / a handback shipped.
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
}

interface ActionArgumentSummary {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  guidance?: string;
  enum?: unknown[];
  items?: Record<string, unknown>;
}

interface ActionSummary {
  name: string;
  description: string;
  type: ActionMcpDefinition["type"];
  complexity: ActionMcpDefinition["complexity"];
  speed: ActionMcpDefinition["speed"];
  reliability: ActionMcpDefinition["reliability"];
  sideEffects: ActionMcpDefinition["sideEffects"];
  requiresApproval: boolean;
  cancellable: boolean;
}

interface SkillSummary {
  name: string;
  description: string;
  tools?: string[];
  ownerType: SkillMcpDefinition["ownerType"];
  ownerId: string;
}

interface SearchMatcher {
  kind: "regex";
  matches(text: string): boolean;
  scoreName(text: string): number;
  scoreDescription(text: string): number;
}

function toActionSummary(action: ActionMcpDefinition): ActionSummary {
  return {
    name: action.name,
    description: action.description,
    type: action.type,
    complexity: action.complexity,
    speed: action.speed,
    reliability: action.reliability,
    sideEffects: action.sideEffects,
    requiresApproval: action.requiresApproval,
    cancellable: action.cancellable,
  };
}

function summarizeActionArguments(action: ActionMcpDefinition): ActionArgumentSummary[] {
  const properties = (action.inputSchema.properties || {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((action.inputSchema.required || []) as string[]);

  return Object.entries(properties).map(([name, prop]) => {
    const type = Array.isArray(prop.type)
      ? prop.type.join("|")
      : typeof prop.type === "string"
        ? prop.type
        : "unknown";
    const summary: ActionArgumentSummary = {
      name,
      type,
      required: required.has(name),
    };
    if (typeof prop.description === "string" && prop.description) {
      summary.description = prop.description;
    }
    const guidance = argumentTypeGuidance(prop);
    if (guidance) {
      summary.guidance = guidance;
    }
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      summary.enum = prop.enum;
    }
    const hasArrayType = Array.isArray(prop.type)
      ? prop.type.includes("array")
      : prop.type === "array";
    if (
      hasArrayType &&
      prop.items != null &&
      typeof prop.items === "object" &&
      !Array.isArray(prop.items)
    ) {
      summary.items = prop.items as Record<string, unknown>;
    }
    return summary;
  });
}

function argumentTypeGuidance(prop: Record<string, unknown>): string | undefined {
  const types = Array.isArray(prop.type)
    ? prop.type.filter((type): type is string => typeof type === "string")
    : typeof prop.type === "string"
      ? [prop.type]
      : [];

  if (types.includes("string")) {
    return undefined;
  }

  if (types.includes("integer")) {
    return 'Pass this value as a JSON integer, e.g. 10. Do not pass it as a string like "10".';
  }

  if (types.includes("number")) {
    return 'Pass this value as a JSON number, e.g. 10. Do not pass it as a string like "10".';
  }

  return undefined;
}

function readAction(action: ActionMcpDefinition) {
  return {
    ...toActionSummary(action),
    arguments: summarizeActionArguments(action),
  };
}

function buildActionSearchText(action: ActionMcpDefinition): string {
  const argText = summarizeActionArguments(action)
    .map((arg) =>
      [
        arg.name,
        arg.type,
        arg.description,
        arg.guidance,
        Array.isArray(arg.enum) ? arg.enum.join(" ") : "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    .join(" ");

  return [
    action.name,
    action.description,
    action.type,
    action.complexity,
    action.speed,
    action.reliability,
    action.sideEffects,
    action.requiresApproval ? "requires approval" : "",
    action.cancellable ? "cancellable" : "",
    argText,
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeSearchLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

function parseRegexQuery(queryText: string): RegExp | null {
  const trimmed = queryText.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return null;
  }

  const flags = trimmed.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) {
    return null;
  }

  try {
    return new RegExp(trimmed.slice(1, lastSlash), flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex query: ${message}`);
  }
}

function matchesRegex(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  return regex.test(text);
}

function compileSearchRegex(queryText: string): RegExp {
  const explicitRegex = parseRegexQuery(queryText);
  if (explicitRegex) {
    return explicitRegex;
  }

  try {
    return new RegExp(queryText, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex query: ${message}`);
  }
}

function createSearchMatcher(queryText: string): SearchMatcher | null {
  const trimmed = queryText.trim();
  if (!trimmed) {
    return null;
  }

  const regex = compileSearchRegex(trimmed);
  return {
    kind: "regex",
    matches: (text) => matchesRegex(regex, text),
    scoreName: (text) => (matchesRegex(regex, text) ? 5 : 0),
    scoreDescription: (text) => (matchesRegex(regex, text) ? 3 : 0),
  };
}

function searchActions(
  actionCatalog: ActionMcpDefinition[],
  queryText: string,
  limit: number | undefined,
): ActionSummary[] {
  const normalizedLimit = normalizeSearchLimit(limit);
  const matcher = createSearchMatcher(queryText);
  const sortedActions = [...actionCatalog].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  if (!matcher) {
    return sortedActions.slice(0, normalizedLimit).map(toActionSummary);
  }

  return sortedActions
    .map((action) => {
      const haystack = buildActionSearchText(action);
      if (!matcher.matches(haystack)) {
        return null;
      }

      let score = 1;
      score += matcher.scoreName(action.name);
      score += matcher.scoreDescription(action.description);
      if (matcher.kind === "regex") {
        score += 1;
      }

      return { action, score };
    })
    .filter((entry): entry is { action: ActionMcpDefinition; score: number } => entry !== null)
    .sort(
      (left, right) =>
        right.score - left.score || left.action.name.localeCompare(right.action.name),
    )
    .slice(0, normalizedLimit)
    .map(({ action }) => toActionSummary(action));
}

function requireAction(
  actionCatalog: ActionMcpDefinition[],
  actionName: string,
): ActionMcpDefinition {
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

function toSkillSummary(skill: SkillMcpDefinition): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    tools: skill.tools,
    ownerType: skill.ownerType,
    ownerId: skill.ownerId,
  };
}

function searchSkills(
  skillCatalog: SkillMcpDefinition[],
  queryText: string,
  limit: number | undefined,
): SkillSummary[] {
  const normalizedLimit = normalizeSearchLimit(limit);
  const matcher = createSearchMatcher(queryText);
  const sortedSkills = [...skillCatalog].sort((left, right) => left.name.localeCompare(right.name));

  if (!matcher) {
    return sortedSkills.slice(0, normalizedLimit).map(toSkillSummary);
  }

  return sortedSkills
    .map((skill) => {
      const haystack = [skill.name, skill.description, ...(skill.tools ?? [])].join(" ");
      if (!matcher.matches(haystack)) {
        return null;
      }

      let score = 1;
      score += matcher.scoreName(skill.name);
      score += matcher.scoreDescription(skill.description);
      if (matcher.kind === "regex" && (skill.tools ?? []).some((tool) => matcher.matches(tool))) {
        score += 1;
      }

      return { skill, score };
    })
    .filter((entry): entry is { skill: SkillMcpDefinition; score: number } => entry !== null)
    .sort(
      (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name),
    )
    .slice(0, normalizedLimit)
    .map(({ skill }) => toSkillSummary(skill));
}

function requireSkill(skillCatalog: SkillMcpDefinition[], skillName: string): SkillMcpDefinition {
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
  getActionCatalog: () => ActionMcpDefinition[],
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
          readAction(requireAction(getActionCatalog(), String(args.action_name))),
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
  subagentTools: ModelToolDefinition[],
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

function buildSkillFacadeTools(getSkillCatalog: () => SkillMcpDefinition[]): FacadeToolDef[] {
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
      description: "Read the full markdown for one available skill.",
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
          return {
            name: skillName,
            content: requireSkill(getSkillCatalog(), skillName).content,
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
    submitOutput: buildSubmitOutputFacadeTool(params.handback, params.executeSubmitOutput),
    interactiveTools: buildInteractiveTools(
      params.supportsInteractiveSurface ?? false,
      params.interactiveSurfaceDetached ?? false,
      !!params.handback,
      params.executeDefer,
    ),
  };
}

// Interactive UI tools — provider-agnostic built-ins that hand an interactive
// element back to the human. The conversational surface renders it off the
// model's tool_use event; the tool itself just validates input and tells the
// model to wait for the next turn.

const PROPOSE_ROUTINE_DIRECTIVE =
  "The routine draft card has been delivered to the user. They turn it on themselves via the card — it creates the routine directly, so do NOT call any create action yourself. Reply with one short line confirming what you've drafted, then end your turn.";

const CONFIRM_OUTPUT_DIRECTIVE =
  "The guardian's approval has been recorded — the result you last submitted is being handed back now, exactly as if they had clicked Approve. Reply with one short line confirming it's shipping, then end your turn. Do not call submit_output or confirm_output again.";

// The confirm_output tool: in a conversational handback, the guardian can approve
// the standing submission by clicking Approve OR by saying so. This tool is how
// the agent relays a *verbal* approval — the surface picks the tool_use up off
// the stream and resolves the handback with the last submitted payload. No
// input: it confirms the most recent submit_output, not a fresh payload, so a
// misclassified reply can never ship a result the guardian never saw.
function buildConfirmOutputFacadeTool(interactiveSurfaceDetached: boolean): FacadeToolDef[] {
  return [
    {
      name: "confirm_output",
      description:
        'Ship the result you last submitted via submit_output, on the guardian\'s behalf, when they have EXPLICITLY approved it in chat (e.g. "yes", "ship it", "looks good", "go ahead"). This is the verbal-approval equivalent of the guardian clicking Approve. Call it ONLY after a submit_output this conversation and ONLY on an unambiguous approval — if the guardian asks for any change or asks a question, do NOT call it; refine and submit_output again, or just answer. Takes no input; it confirms the most recent submission.',
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        // A detached session (exact fork) has no surface resolving handbacks
        // off its stream: telling the model the approval was recorded would be
        // false, and nothing would ship. Refuse instead of lying.
        if (interactiveSurfaceDetached) {
          return {
            content: [
              {
                type: "text",
                text: "This turn runs detached from the conversational surface, so no approval can be recorded and nothing was shipped. Do not retry; end the turn.",
              },
            ],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: CONFIRM_OUTPUT_DIRECTIVE }] };
      },
    },
  ];
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
  if (tzid !== "UTC") {
    const supported =
      typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    if (supported.length > 0 && !supported.includes(tzid)) {
      return { ok: false, error: `propose_routine.tzid "${tzid}" is not a valid IANA timezone` };
    }
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

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// `ask_question` is a host built-in: the question-card is rendered by rome-web
// directly (see packages/web .../blocks/QuestionCard.tsx), not by an app. We
// still ride the existing pending-interaction render/resume path, which keys on
// an `appId`; "core" is the sentinel for a host-owned card (the webchat drain
// skips the app-installed check when `render.builtin` is set).
const ASK_QUESTION_APP_ID = "core";
const ASK_QUESTION_COMPONENT_ID = "question-card";

const ASK_QUESTION_PARK_DIRECTIVE =
  "The question card has been shown to the guardian. Their answers will arrive as the next turn's prompt — do not call any further tools or send another message until then. When you reply, describe only what this step does; do not claim a later step has already happened.";

/** Shape the `ask_question` tool input into a `pendingInteraction` payload that
 * the webchat drain renders as the host built-in question-card component
 * (render.builtin = true, appId = "core"); the guardian's answer resumes the
 * turn through the unchanged interaction-result path. Fails closed on a
 * malformed questions array so a broken card never renders. */
export function normalizeAskQuestionForCard(
  input: unknown,
): { ok: true; questions: Record<string, unknown>[] } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "ask_question input must be an object" };
  }
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: "ask_question.questions must be a non-empty array" };
  }
  for (const [i, q] of questions.entries()) {
    if (!q || typeof q !== "object" || Array.isArray(q)) {
      return { ok: false, error: `ask_question.questions[${i}] must be an object` };
    }
    const o = q as Record<string, unknown>;
    if (!nonEmptyString(o.id)) {
      return { ok: false, error: `ask_question.questions[${i}].id is required` };
    }
    if (!nonEmptyString(o.question)) {
      return { ok: false, error: `ask_question.questions[${i}].question is required` };
    }
    if (o.type !== "single" && o.type !== "multi" && o.type !== "text") {
      return {
        ok: false,
        error: `ask_question.questions[${i}].type must be "single", "multi", or "text"`,
      };
    }
    if (o.type === "single" || o.type === "multi") {
      if (!Array.isArray(o.options) || o.options.length === 0) {
        return {
          ok: false,
          error: `ask_question.questions[${i}] is ${o.type}-choice and needs a non-empty options array`,
        };
      }
      // The web renderer drops non-string options, so a payload like
      // `options: [null]` would otherwise pass and render a choice card with
      // zero buttons — a dead, unanswerable parked turn. Reject up front.
      if (!o.options.every((opt) => nonEmptyString(opt) !== null)) {
        return {
          ok: false,
          error: `ask_question.questions[${i}].options must all be non-empty strings`,
        };
      }
    }
  }
  return { ok: true, questions: questions as Record<string, unknown>[] };
}

// Plain-prose rendering of the questions — the cross-surface fallback for
// channels that can't mount the interactive card (messaging channels, subagents,
// CLI). The guardian replies in prose and the answer arrives as the next turn.
function askQuestionsToPromptText(questions: Record<string, unknown>[]): string {
  return questions
    .map((q) => {
      const base = typeof q.question === "string" ? q.question : "";
      // Mark optional questions so the prose fallback reads the same as the card.
      const text = q.optional === true ? `${base} (optional)` : base;
      const hasOptions = q.type === "single" || q.type === "multi";
      const options =
        hasOptions && Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === "string")
          : [];
      if (!options.length) return text;
      // multi-choice: tell the guardian they can name more than one.
      const head = q.type === "multi" ? `${text} (pick any that apply)` : text;
      const lines = options.map((o) => `- ${o}`);
      // freeText choice: tell the guardian they can also answer freely.
      if (hasOptions && q.freeText === true) lines.push("- (or describe your own)");
      return `${head}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

const DEFER_DESCRIPTION =
  "Schedule a wake-up later in THIS SAME conversation, with full context intact — use it when you're " +
  "watching something that isn't ready yet (a CI run, a build, a reply) instead of ending the turn empty. " +
  "Give a short `name` for what you're watching (it becomes the routine's name) and one of `afterMinutes` or `at`. " +
  "When the time comes you're pinged back in this thread with the whole conversation still in context, so just " +
  "re-evaluate and either finish or `defer` again to check later (minimum one minute, no limit on re-defers). " +
  "After calling defer, write one short line confirming you'll keep watch, then end your turn.";

function buildDeferFacadeTool(
  executeDefer: (input: DeferInput) => Promise<unknown>,
): FacadeToolDef {
  return {
    name: "defer",
    description: DEFER_DESCRIPTION,
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
            "Minutes from now until wakeup, e.g. 5 (five minutes) or 120 (two hours). Minimum 1. Provide exactly one of afterMinutes or at.",
        },
        at: {
          type: "string",
          description:
            "Absolute wakeup time as an ISO 8601 instant, e.g. 2026-06-25T14:30:00Z. Provide exactly one of afterMinutes or at.",
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
  hasHandback: boolean,
  executeDefer?: (input: DeferInput) => Promise<unknown>,
): FacadeToolDef[] {
  // `ask_question` is registered on every surface: webchat mounts the card; other
  // surfaces (messaging channels, subagents, CLI) get the questions relayed as
  // prose from the handler, so the model routes clarifying questions through it
  // regardless of surface. `propose_routine` and `confirm_output` have no prose
  // fallback, so they stay interactive-only (appended below).
  const tools: FacadeToolDef[] = [
    {
      name: "ask_question",
      description:
        "Ask the guardian one or more clarifying questions (single-choice, multi-choice, or short free-text) instead of writing the questions in your text reply — rendered as an interactive card in web chat, or relayed as a plain message on other surfaces. Reach for this whenever a request is open-ended or underspecified and a good result depends on the guardian's preferences, constraints, or choices you do not yet know — ask first, do not guess a generic result. Each call collects one set of questions and the guardian's answers come back as the next turn. Prefer single-choice questions with concrete options when the likely answers are enumerable (set freeText so they can still type their own); use multi when several answers can apply at once. Ask only the few questions that actually change what you do next.",
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
        // Non-interactive surfaces (messaging channels, subagents, CLI) can't
        // mount the card — relay the questions as prose and let the guardian
        // reply in the next turn, so a clarifying question never dead-ends.
        // Detached sessions (exact forks) advertise the card but have no
        // drain to mount it, so they take the same prose path.
        if (!supportsInteractiveSurface || interactiveSurfaceDetached) {
          return {
            content: [
              {
                type: "text",
                text:
                  "This surface cannot render an interactive UI. Ask the guardian the " +
                  "following as a plain message, then wait for their reply before doing " +
                  `anything else:\n\n${askQuestionsToPromptText(result.questions)}`,
              },
            ],
          };
        }
        // `pendingInteraction` payload the webchat drain reads via
        // `readSuspensionFromOutput`; `builtin: true` makes it render the
        // host's question-card (no app) and parks the turn for the answer.
        const payload = {
          pendingInteraction: true,
          appId: ASK_QUESTION_APP_ID,
          render: {
            kind: "inline",
            componentId: ASK_QUESTION_COMPONENT_ID,
            props: { questions: result.questions },
            builtin: true,
          },
          message: ASK_QUESTION_PARK_DIRECTIVE,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    },
  ];
  // `defer` registers on every surface that has a live thread to wake
  // — it injects an inbound message rather than rendering UI, so it needs no
  // interactive surface. Only absent when the session has no defer impl wired.
  if (executeDefer) {
    tools.push(buildDeferFacadeTool(executeDefer));
  }
  // propose_routine and confirm_output render/resolve UI and have no prose
  // fallback, so keep them on interactive surfaces only. Detached sessions
  // (exact forks) keep advertising them — the catalog must stay byte-identical
  // to the source — but their handlers refuse at runtime (below) instead of
  // claiming UI was delivered.
  if (!supportsInteractiveSurface) return tools;
  // confirm_output additionally belongs only to a conversational handback (the
  // surface that resolves it is the handoff approval gate); a plain chat never
  // has it.
  if (hasHandback) tools.push(...buildConfirmOutputFacadeTool(interactiveSurfaceDetached));
  tools.push({
    name: "propose_routine",
    description:
      "Propose a routine (an automation) to the user as an interactive confirm card in web chat. A routine fires one of three ways: when a matching event arrives (kind: event), on a schedule (kind: schedule), or never on its own — a saved playbook the guardian runs by hand from the Routines page's 'Run now' button (kind: manual). Use this — never create the routine silently — once you've gathered enough detail (the trigger, any narrowing, what to do). The card shows a plain-language summary and a 'Turn it on' button that creates the routine directly; you do not call any create action afterwards. Gather missing detail first with the ask_question action. For event routines, discover the exact event type with search_event_catalog rather than guessing.",
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
        },
      },
    },
    handler: async (input) => {
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
      return { content: [{ type: "text", text: PROPOSE_ROUTINE_DIRECTIVE }] };
    },
  });
  return tools;
}

function buildSubmitOutputFacadeTool(
  spec: HandbackSpec | undefined,
  executeSubmitOutput: ((input: unknown) => Promise<unknown>) | undefined,
): FacadeToolDef[] {
  if (!spec || !executeSubmitOutput) return [];
  return [
    {
      name: "submit_output",
      description:
        "Present a schema-valid candidate to the guardian for approval. A later candidate may supersede it after the guardian requests changes.",
      inputSchema: spec.schema,
      handler: (input) =>
        runFacadeTool("submit_output", input, (parsed) => executeSubmitOutput(parsed)),
    },
  ];
}

// Maximum search-result limit is shared between facade tools and any caller
// (e.g. anthropic adapter's zod `.max()`) that needs to advertise the cap.
export const MCP_FACADE_MAX_SEARCH_LIMIT = MAX_SEARCH_LIMIT;
