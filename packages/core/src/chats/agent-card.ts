// An agent card: a widget an agent composes itself, to show structured
// content such as an itinerary, a comparison or a few key numbers. Rome owns
// it, the agent writes its look and its plain-text line, and the message
// keeps it as it was shown. Vocabulary: docs/domains/chats.md#agent-card.

import { randomUUID } from "node:crypto";
import {
  checkWidgetUi,
  type MessagePart,
  WIDGET_UI_CHART_MAX_POINTS,
  WIDGET_UI_ICONS,
  type WidgetUi,
} from "@rome-os/app-runtime";

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
  "Chart",
] as const;

/** The most an agent card's `ui` may hold, as JSON characters. */
export const AGENT_CARD_MAX_UI_CHARS = 8000;

/** The most an agent card's plain-text line may hold. */
export const AGENT_CARD_MAX_TEXT_CHARS = 2000;

/** The name of the tool that shows an agent card, for the Concierge and for every other agent. */
export const SHOW_CARD_TOOL = "show_card";

/** Whether `tool` is the tool that shows an agent card. A provider may drop
 *  the `mcp__<server>__` prefix, so a prefixed name matches too. */
export function isShowCardTool(tool: unknown): boolean {
  return (
    typeof tool === "string" && (tool === SHOW_CARD_TOOL || tool.endsWith(`__${SHOW_CARD_TOOL}`))
  );
}

/** What the model reads of `show_card`. `sayInstead` names how this agent
 *  sends plain text, for a card it cannot show. */
export function showCardDescription(sayInstead: string): string {
  return (
    "Show the guardian structured content as a card you compose. It only shows; nobody answers it, and you go on after it. " +
    "Use it only when the content has a real structure that reads better laid out: a few key numbers (such as a daily summary against a usual range), three or more steps or an itinerary, or options compared side by side. Never for a greeting, small talk, a short answer or a single fact. At most one card per reply. Text around the card may add what it does not hold, but never repeats what the card shows. " +
    "`ui` is an A2UI card: a flat list of components, each with an `id`, naming its children by id, drawn from the one whose id is `root`. Components: " +
    "Text {text, variant?: h1|h2|h3|h4|h5|body|caption, tone?: info|warning|success, icon?, href?}; Stat {label, value, unit?, caption?, range?: {low, high}, icon?}; Chart {kind: bar, points: [{label, value, highlight?: accent|warning}], unit?, caption?}; Progress {value, max?, label?}; Image {url (https only), description?, variant?: icon|avatar|smallFeature|mediumFeature|largeFeature|header}; Row {children: [ids], justify?, align?, icon?, href?}; Column {children: [ids], justify?, align?}; List {children: [ids], direction?: vertical|horizontal}. " +
    "A heading Text with a caption Text under it reads as the card's title and subtitle. Put every Stat of a group in one Row, however many: it lays out as an even two-column grid. Never split a group across several Rows, which leaves a tile alone on its line. " +
    "A Stat's `range` is the usual range in the value's unit, with `value` a plain number in that unit (sleep as 6.1 with unit h, not \"6h 05m\"): the card itself shows the range and whether the value is normal, high or low, so never write that verdict in its caption. State each number against its range and stop there: never guess at causes, and never give a medical diagnosis. " +
    `A Chart draws bars, at most ${WIDGET_UI_CHART_MAX_POINTS}, such as a week of one number; highlight today with accent and an outlier with warning. ` +
    "A Text with a `tone` is a callout strip: at most one, for the one thing to act on or keep in mind. " +
    `\`icon\` is one of ${WIDGET_UI_ICONS.join(", ")}. \`href\` (https: or maps://, such as maps://?q=Belém+Tower) makes a list row or Row open that link when pressed. ` +
    "Write every value out: no `data`, `bind` or `{ path }`. No Button, ChoicePicker or TextField: to ask the guardian something, use the question card. " +
    `\`ui\` stays under ${AGENT_CARD_MAX_UI_CHARS} characters of JSON. ` +
    "`text` is the same content as plain text: the chat's line for the card, what a lock screen or a text-only chat shows, and what you read back later. " +
    `A refused card says why: fix it once, or ${sayInstead} instead. Where cards cannot show, the answer says so: ${sayInstead}.`
  );
}

/** The input `show_card` takes. */
export const SHOW_CARD_INPUT_SCHEMA = {
  type: "object",
  required: ["ui", "text"],
  properties: {
    ui: {
      type: "object",
      required: ["components"],
      properties: { components: { type: "array", items: { type: "object" } } },
    },
    text: {
      type: "string",
      description: `The card's content as plain text, at most ${AGENT_CARD_MAX_TEXT_CHARS} characters.`,
    },
  },
} as const;

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

// Cards core's own `show_card` handed to the webchat drain, by a token only
// this process issued, with when each lapses. Any tool, such as one on an
// agent's external MCP server, can be named `show_card` and print the same
// JSON, so neither the name nor the output proves the card is Rome's; the
// token does, and the drain stores the card kept here, not the output's. A
// token outlives no restart, which only drops a card shown across one.
const issuedCards = new Map<string, { part: AgentCardPart; lapses: number }>();
const ISSUED_CARD_MS = 30 * 60 * 1000;

/** Keep a card core's `show_card` checked, for the drain to store, and the
 *  token that claims it. */
export function issueAgentCard(part: AgentCardPart, now = Date.now()): string {
  for (const [token, card] of issuedCards) if (card.lapses <= now) issuedCards.delete(token);
  const token = randomUUID();
  issuedCards.set(token, { part, lapses: now + ISSUED_CARD_MS });
  return token;
}

/** The card a token claims, stored under the tool call that showed it, or
 *  null when this process issued no such token or it lapsed. A token claims
 *  its card once. */
export function claimAgentCard(
  token: unknown,
  toolUseId: string,
  now = Date.now(),
): AgentCardPart | null {
  if (typeof token !== "string") return null;
  const card = issuedCards.get(token);
  issuedCards.delete(token);
  if (!card || card.lapses <= now) return null;
  return { ...card.part, toolUseId };
}
