// An action as the agent finds it and what a tool call on one hands back.
// Agent model: docs/concepts/agents.md.

import {
  type ActionConfig,
  type ActionResult,
  checkWidgetUi,
  type ShownUi,
} from "@rome-os/app-runtime";
import { createSearchMatcher, normalizeSearchLimit } from "./catalog-search.js";
import type { TurnFacts } from "./turn-facts.js";

/** One action this agent may call, as the model reads it. */
export interface AgentAction {
  name: string;
  description: string;
  type: ActionConfig["type"];
  complexity: ActionConfig["complexity"];
  speed: ActionConfig["speed"];
  reliability: ActionConfig["reliability"];
  sideEffects: ActionConfig["sideEffects"];
  requiresApproval: boolean;
  cancellable: boolean;
  inputSchema: Record<string, unknown>;
}

/** Port. What an agent may call, for the turn that calls it. */
export interface AgentActions {
  /** Read on every call, so an action installed mid-session shows at once. */
  list(turn: TurnFacts): readonly AgentAction[];
  /** Whether the turn's agent may call action `name`, under any of its names. */
  permits(turn: TurnFacts, name: string): boolean;
  /**
   * Runs an action the turn's agent may call, attributed to the turn. Resolves
   * with the action's result, its domain rejections included. Throws
   * `Unknown action: <name>` for any other name, and on an invocation failure;
   * either becomes an error result.
   */
  run(turn: TurnFacts, name: string, input: unknown): Promise<ActionResult>;
  /** The app that owns action `name`, under any of its names, or undefined
   *  for an action Rome owns or one it does not know. */
  appOf(name: string): string | undefined;
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
  type: AgentAction["type"];
  complexity: AgentAction["complexity"];
  speed: AgentAction["speed"];
  reliability: AgentAction["reliability"];
  sideEffects: AgentAction["sideEffects"];
  requiresApproval: boolean;
  cancellable: boolean;
}

export function toActionSummary(action: AgentAction): ActionSummary {
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

function summarizeActionArguments(action: AgentAction): ActionArgumentSummary[] {
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

export function describeAction(action: AgentAction) {
  return {
    ...toActionSummary(action),
    arguments: summarizeActionArguments(action),
  };
}

function buildActionSearchText(action: AgentAction): string {
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

export function searchActions(
  actionCatalog: readonly AgentAction[],
  queryText: string,
  limit: number | undefined,
): ActionSummary[] {
  const normalizedLimit = normalizeSearchLimit(limit);
  const matches = createSearchMatcher(queryText);
  const sortedActions = [...actionCatalog].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  if (!matches) {
    return sortedActions.slice(0, normalizedLimit).map(toActionSummary);
  }

  return sortedActions
    .map((action) => {
      const haystack = buildActionSearchText(action);
      if (!matches(haystack)) {
        return null;
      }

      // A match in the name ranks above one in the description.
      const score = (matches(action.name) ? 5 : 0) + (matches(action.description) ? 3 : 0);

      return { action, score };
    })
    .filter((entry): entry is { action: AgentAction; score: number } => entry !== null)
    .sort(
      (left, right) =>
        right.score - left.score || left.action.name.localeCompare(right.action.name),
    )
    .slice(0, normalizedLimit)
    .map(({ action }) => toActionSummary(action));
}

/**
 * What a tool call on an action hands back, read by two parties: the model,
 * and the webchat drain, which mounts cards from `pendingInteraction`,
 * `showWidget`, `appId`, `render`, `componentId`, `props`, `ui`, `bind`,
 * `text` and `placeWidget`.
 * Those field names are a contract with the drain. An `error` result passes
 * through as data and reaches the model as an ordinary tool result, not an
 * error one. `appId` is the app that owns the action; a `show_widget` card is
 * that app's, and an action no app owns shows none.
 */
export function actionToolOutput(
  result: ActionResult,
  widgetsShow: boolean,
  appId?: string,
): unknown {
  if (result.status === "show_widget") {
    if ("ui" in result.widget) return shownUiOutput(result.widget, widgetsShow, appId);
    const { componentId, props, text, waits } = result.widget;
    if (!appId) {
      return {
        message: `No card was shown: only an app's action can show one. ${text}`,
      };
    }
    // A widget that waits is the same card as a pending interaction, and
    // stores the same part, so the iOS app and stored messages read it as one.
    if (waits === true) {
      return actionToolOutput(
        {
          status: "pending_interaction",
          interaction: {
            appId,
            promptText: text,
            render: { kind: "inline", componentId, ...(props ? { props } : {}) },
          },
        },
        widgetsShow,
      );
    }
    if (!widgetsShow) {
      return {
        message:
          `The "${componentId}" card could not be shown, because this conversation cannot ` +
          `show cards. Tell the guardian what it would have shown, in a message: ${text}`,
      };
    }
    return {
      showWidget: true,
      appId,
      componentId,
      ...(props ? { props } : {}),
      text,
      message: `${text} The card is shown in your message. Continue your turn as normal.`,
    };
  }
  if (result.status === "pending_approval") {
    return {
      pendingApproval: true,
      approvalId: result.approval.approvalId,
      message:
        `Action "${result.approval.actionName}" was submitted for guardian approval. ` +
        `A proposal card has been shown to the guardian in the originating channel, and they will review it asynchronously. ` +
        `Do NOT wait for the result. Continue with any remaining work in this turn that does not depend on this action's output. ` +
        `When the guardian resolves the approval, a new turn will be started automatically with the outcome.`,
    };
  }
  if (result.status === "pending_interaction") {
    const { appId, promptText, render } = result.interaction;
    // Nothing can mount the component, so the model relays the prompt as
    // a plain message. The guardian's reply arrives as the next turn, like
    // any clarifying question.
    if (!widgetsShow) {
      return {
        message:
          "This surface cannot render an interactive UI. Ask the guardian the " +
          "following as a plain message, then wait for their reply before doing " +
          `anything else:\n\n${promptText}`,
      };
    }
    // The chat client mounts the component off this tool result (the
    // drain persists a pending_interaction card keyed by toolUseId). The
    // guardian's outcome arrives as a new turn, so the model stops here.
    return {
      pendingInteraction: true,
      appId,
      render,
      message:
        `The "${render.componentId}" component has been shown to the guardian. It asks them to: ${promptText} ` +
        `Their response will arrive as the next turn's prompt — do not call any further tools ` +
        `or send another message until then. When you reply, describe only what this step does; ` +
        `do not claim any later step has already happened.`,
    };
  }
  if (result.status === "place_widget") {
    const { appId, route, params } = result.placement;
    // Not a park: the drain emits a `widget_placement` event off this tool
    // result and the turn goes on. Where no widget shows, the model is told
    // so, because the guardian sees nothing.
    if (!widgetsShow) {
      return {
        message:
          `The "${appId}" widget could not be shown — this surface has no workspace to ` +
          `place it on. Continue without it.`,
      };
    }
    return {
      placeWidget: true,
      appId,
      ...(route !== undefined ? { route } : {}),
      ...(params !== undefined ? { params } : {}),
      message:
        `The "${appId}" widget has been placed on the guardian's workspace for them to ` +
        `glance at. This needed no input from them — continue as normal, and don't claim ` +
        `they have acted on it.`,
    };
  }
  if (result.status === "error") {
    return result;
  }
  return result.data ?? result;
}

function shownUiOutput(widget: ShownUi, widgetsShow: boolean, appId?: string): unknown {
  const { ui, bind, text } = widget;
  if (!appId) {
    return { message: `No card was shown: only an app's action can show one. ${text}` };
  }
  const problems = checkWidgetUi(ui, bind ?? {});
  if (problems.length > 0) {
    return {
      message:
        `No card was shown, because the card's description is not valid (${problems.join("; ")}). ` +
        `Tell the guardian what it would have shown, in a message: ${text}`,
    };
  }
  if (!widgetsShow) {
    return {
      message:
        "The card could not be shown, because this conversation cannot show cards. " +
        `Tell the guardian what it would have shown, in a message: ${text}` +
        (widget.waits === true ? " Then wait for their reply before doing anything else." : ""),
    };
  }
  if (widget.waits === true) {
    // The card answers the agent through one of its events, which the app
    // handles; the answer arrives as the next turn, so the model stops here.
    return {
      showWidget: true,
      waits: true,
      appId,
      ui,
      ...(bind ? { bind } : {}),
      text,
      message:
        `${text} The card has been shown to the guardian, and their answer will arrive as the ` +
        `next turn's prompt — do not call any further tools or send another message until then.`,
    };
  }
  return {
    showWidget: true,
    appId,
    ui,
    ...(bind ? { bind } : {}),
    text,
    message: `${text} The card is shown in your message. Continue your turn as normal.`,
  };
}
