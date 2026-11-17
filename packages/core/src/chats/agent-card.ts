// An agent card: a widget an agent composes itself, to show structured
// content such as an itinerary, a comparison or a few key numbers. Rome owns
// it, the agent writes its look and its plain-text line, and the message
// keeps it as it was shown. Vocabulary: docs/domains/chats.md#agent-card.

import { checkWidgetUi, type MessagePart, type WidgetUi } from "@rome-os/app-runtime";

/** The components an agent card may use: display only. A button, a picker or
 *  a text field would need an owner to handle its events, and an agent card
 *  has none; a question goes through the question card instead. */
export const AGENT_CARD_COMPONENTS = [
  "Text",
  "Stat",
  "List",
  "Row",
  "Column",
  "Image",
  "Progress",
] as const;

/** The most an agent card's `ui` may hold, as JSON characters. */
export const AGENT_CARD_MAX_UI_CHARS = 8000;

/** The most an agent card's plain-text line may hold. */
export const AGENT_CARD_MAX_TEXT_CHARS = 2000;

type AgentCardPart = Extract<MessagePart, { type: "widget" }> & { ui: WidgetUi };

/** Where a value reads the card's data model, which an agent card has none of. */
function pathsIn(value: unknown, at: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => pathsIn(item, `${at}.${i}`, found));
    return;
  }
  if (!value || typeof value !== "object") return;
  const o = value as Record<string, unknown>;
  if ("path" in o) found.push(at);
  for (const [key, v] of Object.entries(o)) pathsIn(v, `${at}.${key}`, found);
}

/**
 * The problems that keep `ui` and `text` from showing as an agent card, or an
 * empty list when every reader can draw it: a card every reader can draw
 * ({@link checkWidgetUi}), display components only, every value written out
 * (no data model, no `{ path }`, no `bind`), images from https URLs only, and
 * both within their size caps.
 */
export function checkAgentCard(ui: unknown, text: unknown): string[] {
  const problems: string[] = [];
  if (typeof text !== "string" || !text.trim()) {
    problems.push("text is required: the card's content as plain text");
  } else if (text.length > AGENT_CARD_MAX_TEXT_CHARS) {
    problems.push(`text is ${text.length} characters, over the ${AGENT_CARD_MAX_TEXT_CHARS} limit`);
  }
  const size = JSON.stringify(ui ?? null).length;
  if (size > AGENT_CARD_MAX_UI_CHARS) {
    problems.push(
      `ui is ${size} characters of JSON, over the ${AGENT_CARD_MAX_UI_CHARS} limit: show less`,
    );
    return problems;
  }
  const shape = checkWidgetUi(ui);
  if (shape.length > 0) return [...problems, ...shape];
  const card = ui as WidgetUi;
  if (card.data !== undefined) {
    problems.push("ui.data is not allowed: write every value into its component");
  }
  card.components.forEach((component, i) => {
    if (!(AGENT_CARD_COMPONENTS as readonly string[]).includes(component.component)) {
      problems.push(
        `ui.components.${i} ("${component.id}") is a ${component.component}, which an agent card cannot hold: use only ${AGENT_CARD_COMPONENTS.join(", ")}. To ask the guardian something, use the question card instead`,
      );
    }
  });
  const paths: string[] = [];
  card.components.forEach((component, i) => pathsIn(component, `ui.components.${i}`, paths));
  for (const at of paths) {
    problems.push(`${at} reads a { path }: write the value itself, since a card has no data`);
  }
  return problems;
}

/** The widget part that stores an agent card, or the problems that keep it
 *  from showing. `toolUseId` is the call that showed it. */
export function agentCardPart(
  ui: unknown,
  text: unknown,
  toolUseId: string,
): { part: AgentCardPart } | { problems: string[] } {
  const problems = checkAgentCard(ui, text);
  if (problems.length > 0) return { problems };
  return {
    part: {
      type: "widget",
      toolUseId,
      appId: "core",
      text: (text as string).trim(),
      ui: ui as WidgetUi,
    },
  };
}
