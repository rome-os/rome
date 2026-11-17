// What the baseline scenarios check, shared by the English, Chinese and
// long scenarios: the types, the checks a scenario picks from, and the
// standing rules every scenario runs. docs/concierge-eval.md#baseline

import { chineseStyle, noTaskChatPointer, noTrailingOffer, oneEmoji } from "./baseline-rules.js";
import type { Step } from "./scenarios.js";
import type { TimedTurn } from "./timing.js";

/** The policy row a scenario stands for. */
export type PolicyRow =
  | "chat"
  | "simple-qa"
  | "quick-lookup"
  | "reasoning"
  | "simple-task"
  | "heavy-task"
  | "recall"
  | "multi-turn"
  | "long-context"
  | "cards";

/** What a scenario's checks read: the guardian turns by step, every turn, and what was said. */
export interface CheckInput {
  /** The guardian turn each step started, in step order; null when none was timed. */
  steps: (TimedTurn | null)[];
  /** Every timed turn of the chat, system turns included. */
  turns: TimedTurn[];
  /** The Concierge's text messages after each step, in step order. */
  saidAfter: string[][];
  /** The plain-text lines of the cards the Concierge composed after each step, in step order. */
  cardsAfter: string[][];
  /** The Concierge's reaction to each step's message, in step order; null for none. */
  reactions: (string | null)[];
  /** Every Concierge text message. */
  said: string[];
  /** The chat's tasks, as the Tasks panel lists them. */
  tasks: { status: string; endReason: string | null }[];
}

/** An owner message. A setup message only prepares the chat: its turn is not reported. */
export interface BaselineStep extends Step {
  setup?: boolean;
}

export interface BaselineScenario {
  id: string;
  row: PolicyRow;
  /** The language the owner writes in, and the Concierge should answer in. */
  lang: "en" | "zh";
  about: string;
  /** The owner's messages. A short `settleS` keeps the next step's session warm. */
  steps: BaselineStep[];
  /** Failed hard checks, each as a short note; empty when every check passed. */
  check: (input: CheckInput) => string[];
  /** What the judge scores the answers against. */
  rubric: string;
  /** Figures the report shows beside the checks, such as answer lengths. */
  measure?: (input: CheckInput) => Record<string, number | null>;
}

export const tool = (turn: TimedTurn | null, name: string) => turn?.tools[name] ?? 0;

/** A message that only acknowledges or announces, opening the reply. */
const FILLER =
  /^\s*(got it|on it|sure[,!.]|okay[,!.]|ok[,!.]|noted|will do|let me|i['’]ll (look|check|find|get)|i['’]m (on|checking|looking)|one moment|好的|收到|马上|我来)/i;

export function noFiller(said: string[]): string[] {
  return said
    .filter((t) => FILLER.test(t) && t.length < 120)
    .map((t) => `filler: "${t.slice(0, 60)}"`);
}

/**
 * The step was answered in the turn it started, with at most `maxSearches`
 * web searches, and the answer ends on the answer.
 */
export function answeredInline(input: CheckInput, step: number, maxSearches = 0): string[] {
  const turn = input.steps[step] ?? null;
  const notes: string[] = [];
  if (!turn) notes.push(`step ${step + 1}: no timed turn`);
  if (tool(turn, "chat_start") > 0) notes.push(`step ${step + 1}: started a task`);
  const searches = tool(turn, "websearch");
  if (searches > maxSearches) notes.push(`step ${step + 1}: ${searches} web searches`);
  if ((input.saidAfter[step] ?? []).length === 0 && !turn?.reactedMs) {
    notes.push(`step ${step + 1}: no answer`);
  }
  notes.push(...noTrailingOffer(input.saidAfter[step] ?? [], step));
  return notes;
}

/** The length of what the Concierge said after a step, in characters. */
export const saidLength = (input: CheckInput, step: number) =>
  (input.saidAfter[step] ?? []).join("\n").length;

/** A weekday other than Friday, in English or Chinese. */
const NOT_FRIDAY =
  /\b(monday|tuesday|wednesday|thursday|saturday|sunday)\b|(周|星期|礼拜)[一二三四六日天]/i;

/** Every weekday the answer names for 2026-11-20 is Friday. */
export function fridayOnly(said: string[]): string[] {
  const wrong = said.find((t) => NOT_FRIDAY.test(t));
  return wrong ? [`names the wrong weekday: "${wrong.slice(0, 80)}"`] : [];
}

export function matches(said: string[], pattern: RegExp, what: string): string[] {
  return said.some((t) => pattern.test(t)) ? [] : [`no answer names ${what}`];
}

export function delegated(input: CheckInput, step = 0): string[] {
  const notes: string[] = [];
  if (tool(input.steps[step] ?? null, "chat_start") === 0) notes.push("did not start a task");
  if (!input.tasks.some((t) => t.status === "ended" && t.endReason === "done")) {
    notes.push("no task ended done");
  }
  // The result reaches the owner in a system turn that forwards or says it.
  const relays = input.turns.filter(
    (t) => t.trigger === "system" && (tool(t, "chat_forward") > 0 || tool(t, "say") > 0),
  );
  if (relays.length === 0) notes.push("no system turn relayed the result");
  return notes;
}

/**
 * The step was answered in its own turn with a card, with at most
 * `maxSearches` web searches, and any message beside it ends on the answer.
 * A card alone answers the step.
 */
export function shownCard(input: CheckInput, step: number, maxSearches = 3): string[] {
  const turn = input.steps[step] ?? null;
  const notes: string[] = [];
  if (!turn) notes.push(`step ${step + 1}: no timed turn`);
  if (tool(turn, "chat_start") > 0) notes.push(`step ${step + 1}: started a task`);
  const searches = tool(turn, "websearch");
  if (searches > maxSearches) notes.push(`step ${step + 1}: ${searches} web searches`);
  if ((input.cardsAfter[step] ?? []).length === 0) notes.push(`step ${step + 1}: no card`);
  notes.push(...noTrailingOffer(input.saidAfter[step] ?? [], step));
  return notes;
}

/** The rows whose answers are too short or too light for a card. */
const NO_CARD_ROWS: readonly PolicyRow[] = ["chat", "simple-qa"];

/** At most one card per reply, and none for a greeting or a short answer. */
export function cardRules(scenario: BaselineScenario, input: CheckInput): string[] {
  const notes = input.cardsAfter.flatMap((cards, step) =>
    cards.length > 1 ? [`card: ${cards.length} cards after step ${step + 1}`] : [],
  );
  const shown = input.cardsAfter.flat().length;
  if (shown > 0 && NO_CARD_ROWS.includes(scenario.row)) {
    notes.push(`card: ${shown} card(s) in a ${scenario.row} scenario`);
  }
  return notes;
}

/** The rules every scenario keeps, whatever it asks: emoji, task results, cards, and Chinese style. */
export function standingRules(scenario: BaselineScenario, input: CheckInput): string[] {
  return [
    ...oneEmoji(input.said),
    ...noTaskChatPointer(input.said),
    ...cardRules(scenario, input),
    ...(scenario.lang === "zh" ? chineseStyle([...input.said, ...input.cardsAfter.flat()]) : []),
  ];
}
