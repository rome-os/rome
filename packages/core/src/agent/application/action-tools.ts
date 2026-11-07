// The tools an agent finds and runs actions with.

import {
  actionToolOutput,
  describeAction,
  searchActions,
  toActionSummary,
  type AgentAction,
  type AgentActions,
} from "../domain/agent-action.js";
import type { AgentLog } from "../domain/agent-log.js";
import { MAX_SEARCH_LIMIT, SEARCH_LIMIT_DESCRIPTION } from "../domain/catalog-search.js";
import type { RomeTool } from "../domain/rome-tools.js";
import type { RomeToolRunner } from "./rome-tool-runner.js";

function requireAction(actionCatalog: readonly AgentAction[], actionName: string): AgentAction {
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

/** `list_actions`, `read_action`, `search_actions` and `execute_action`. */
export function actionTools(
  actions: AgentActions,
  widgetsShow: boolean,
  run: RomeToolRunner,
  log: AgentLog,
): RomeTool[] {
  return [
    {
      name: "list_actions",
      description: "List the actions available to this agent.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: (input) =>
        run("list_actions", input, async () =>
          [...actions.list()]
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
        run("read_action", input, async (args) =>
          describeAction(requireAction(actions.list(), String(args.action_name))),
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
        run("search_actions", input, async (args) =>
          searchActions(
            actions.list(),
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
        run("execute_action", input, async (args) => {
          const actionName = String(args.action_name);
          const parsedArgs = assertJsonArgs(args.json_args);
          log.info("executing action", {
            tool: "execute_action",
            action: actionName,
          });
          return actionToolOutput(await actions.run(actionName, parsedArgs), widgetsShow);
        }),
    },
  ];
}
