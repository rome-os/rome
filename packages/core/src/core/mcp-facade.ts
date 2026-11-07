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

import { createLogger } from "../logger.js";
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
  type ModelToolCallContext,
  type RomeTool,
  type RomeToolDefinition,
  type RomeToolResult,
  type Skill,
} from "../agent/index.js";

const log = createLogger("mcp-facade");

export interface FacadeBundle {
  /** Always four tools: list_actions, read_action, search_actions, execute_action. */
  actions: RomeTool[];
  /** One tool per subagent declared in `subagentTools`. */
  subagents: RomeTool[];
  /** Three tools when `skillCatalog` is non-empty, otherwise empty. */
  skills: RomeTool[];
  /**
   * `ask_question`, registered everywhere (a card where a widget shows, a
   * plain message elsewhere), `defer`, and the session tools after it. The
   * webchat drain picks a card's tool_use event up out of band.
   */
  interactiveTools: RomeTool[];
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
   * `ask_question` registers either way (it relays prose off-webchat).
   */
  supportsInteractiveSurface?: boolean;
  /**
   * True when the interactive catalog must stay advertised but no surface
   * drains this session's stream to deliver UI — exact-mode forked turns,
   * whose tool catalog must stay byte-identical to their webchat source
   * (prefix identity) while nothing can mount cards.
   * Runtime behavior degrades honestly: `ask_question` relays prose, the same
   * as a non-interactive surface.
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
   * Tools this session carries beyond the ones every session of its agent has,
   * served after `defer` in the order given. Their handlers own their own
   * context.
   */
  sessionTools?: RomeTool[];
  /**
   * The agent's text never reaches the guardian, so `defer` does not ask it
   * to confirm in text: it could only confirm with another message.
   */
  textPrivate?: boolean;
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
): Promise<RomeToolResult> {
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
): RomeTool[] {
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
): RomeTool[] {
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

function buildSkillFacadeTools(getSkillCatalog: () => readonly Skill[]): RomeTool[] {
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
      params.sessionTools,
      params.textPrivate ?? false,
    ),
  };
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
): RomeTool {
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
  sessionTools: RomeTool[] = [],
  textPrivate = false,
): RomeTool[] {
  const widgetsShow = showsWidgets(
    supportsInteractiveSurface ? "card" : "plain_text",
    !interactiveSurfaceDetached,
  );
  // `ask_question` is registered on every surface: webchat mounts the card; other
  // surfaces (messaging channels, subagents, CLI) get the questions relayed as
  // prose from the handler, so the model routes clarifying questions through it
  // regardless of surface.
  const tools: RomeTool[] = [
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
  return tools;
}
