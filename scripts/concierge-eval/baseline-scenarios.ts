// The baseline suite: one or more scenarios per row of the Concierge's
// model and effort policy, each with hard checks on what the turns did and a
// rubric a judge model scores the answers by. `pnpm concierge:baseline`
// plays them. Change one and earlier runs stop being comparable: bump
// BASELINE_VERSION. docs/concierge-eval.md#baseline

import type { Step } from "./scenarios.js";
import type { TimedTurn } from "./timing.js";

export const BASELINE_VERSION = 1;

/** The policy row a scenario stands for. */
export type PolicyRow =
  | "chat"
  | "simple-qa"
  | "quick-lookup"
  | "reasoning"
  | "simple-task"
  | "heavy-task"
  | "relay"
  | "recall";

/** What a scenario's checks read: the guardian turns by step, every turn, and what was said. */
export interface CheckInput {
  /** The guardian turn each step started, in step order; null when none was timed. */
  steps: (TimedTurn | null)[];
  /** Every timed turn of the chat, system turns included. */
  turns: TimedTurn[];
  /** The Concierge's text messages after each step, in step order. */
  saidAfter: string[][];
  /** Every Concierge text message. */
  said: string[];
  /** The chat's tasks, as the Tasks panel lists them. */
  tasks: { status: string; endReason: string | null }[];
}

export interface BaselineScenario {
  id: string;
  row: PolicyRow;
  about: string;
  /** The owner's messages. A short `settleS` keeps the next step's session warm. */
  steps: Step[];
  /** Failed hard checks, each as a short note; empty when every check passed. */
  check: (input: CheckInput) => string[];
  /** What the judge scores the answers against. */
  rubric: string;
}

const tool = (turn: TimedTurn | null, name: string) => turn?.tools[name] ?? 0;

/** A message that only acknowledges or announces, opening the reply. */
const FILLER =
  /^\s*(got it|on it|sure[,!.]|okay[,!.]|ok[,!.]|noted|will do|let me|i['’]ll (look|check|find|get)|i['’]m (on|checking|looking)|one moment|好的|收到|马上|我来)/i;

function noFiller(said: string[]): string[] {
  return said.filter((t) => FILLER.test(t) && t.length < 120).map((t) => `filler: "${t.slice(0, 60)}"`);
}

function answeredInline(input: CheckInput, step: number, maxSearches = 0): string[] {
  const turn = input.steps[step] ?? null;
  const notes: string[] = [];
  if (!turn) notes.push(`step ${step + 1}: no timed turn`);
  if (tool(turn, "chat_start") > 0) notes.push(`step ${step + 1}: started a task`);
  const searches = tool(turn, "websearch");
  if (searches > maxSearches) notes.push(`step ${step + 1}: ${searches} web searches`);
  if ((input.saidAfter[step] ?? []).length === 0 && !turn?.reactedMs) {
    notes.push(`step ${step + 1}: no answer`);
  }
  return notes;
}

function matches(said: string[], pattern: RegExp, what: string): string[] {
  return said.some((t) => pattern.test(t)) ? [] : [`no answer names ${what}`];
}

function delegated(input: CheckInput, step = 0): string[] {
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

const VOICE =
  "Voice: short and direct, like a capable assistant texting its owner; no preamble, no filler such as 'Got it' or 'Let me check', no closing offers.";

export const BASELINE_SCENARIOS: BaselineScenario[] = [
  {
    id: "chat-hi-thanks",
    row: "chat",
    about: "A greeting, then a thanks sent while the session is still warm",
    steps: [{ text: "hey, good morning!", settleS: 4 }, { text: "thanks!", settleS: 4 }],
    check: (i) => [
      ...answeredInline(i, 0),
      ...(i.steps[1] && (tool(i.steps[1], "chat_start") > 0 || tool(i.steps[1], "websearch") > 0)
        ? ["the thanks did work"]
        : []),
      ...((i.saidAfter[1] ?? []).length > 1 ? ["more than one message for a thanks"] : []),
      ...noFiller(i.said),
    ],
    rubric: `The owner greets the assistant, then says thanks. A good reply to the greeting is one short friendly line. A good response to "thanks" is a reaction or at most one very short line. Score down for long replies, questions back that are not needed, or offering help lists. ${VOICE}`,
  },
  {
    id: "qa-coffee",
    row: "simple-qa",
    about: "A general-knowledge question answered from what the model knows",
    steps: [{ text: "What's the difference between a flat white and a latte?", settleS: 6 }],
    check: (i) => [
      ...answeredInline(i, 0),
      ...matches(i.said, /milk|foam|microfoam/i, "the milk"),
      ...noFiller(i.said),
    ],
    rubric: `Correct answer: a flat white has less milk and a thin layer of velvety microfoam, so it tastes stronger of coffee and is usually smaller; a latte has more steamed milk and a thicker foam layer. Often a flat white uses a double shot/ristretto. Score correctness and brevity (2-4 sentences is ideal). ${VOICE}`,
  },
  {
    id: "qa-units",
    row: "simple-qa",
    about: "A quick calculation",
    steps: [{ text: "How much is 72°F in Celsius?", settleS: 6 }],
    check: (i) => [...answeredInline(i, 0), ...matches(i.said, /22[.,]2/, "22.2 °C"), ...noFiller(i.said)],
    rubric: `Correct answer: about 22.2 °C. One line is ideal. ${VOICE}`,
  },
  {
    id: "lookup-web",
    row: "quick-lookup",
    about: "A fresh fact that needs a web search, done inline",
    steps: [{ text: "Who won the most recent Nobel Prize in Literature?", settleS: 8 }],
    check: (i) => {
      const notes = answeredInline(i, 0, 3);
      if (tool(i.steps[0] ?? null, "websearch") === 0) notes.push("answered without searching");
      return [...notes, ...noFiller(i.said)];
    },
    rubric: `The answer must name the most recent Nobel Prize in Literature laureate (check with a web search; the prize is announced each October) and the year. A short reason for the prize is a plus, more is noise. Score 1 if the laureate is wrong or stale. ${VOICE}`,
  },
  {
    id: "lookup-memory",
    row: "quick-lookup",
    about: "Personal data from the Concierge's memory",
    steps: [{ text: "When is my dentist appointment again?", settleS: 8 }],
    check: (i) => [
      ...answeredInline(i, 0),
      ...matches(i.said, /(nov(ember)?\.? ?20|20(th)? ?nov|11\/20|11月20)/i, "November 20"),
      ...matches(i.said, /15:30|3:30|3\.30|下午三点半/i, "15:30"),
      ...noFiller(i.said),
    ],
    rubric: `The owner's memory says: dentist appointment with Dr. Weber on 2026-11-20 at 15:30, a check-up and cleaning. The answer must give the date and time, ideally the dentist's name, in one line. The owner's memory holds other true facts too (for example, they usually watch a movie on Friday evenings), so a relevant extra detail is fine. Score 1 if it contradicts the appointment facts or says it does not know. ${VOICE}`,
  },
  {
    id: "reason-airport",
    row: "reasoning",
    about: "A small planning question that needs careful reasoning",
    steps: [
      {
        text: "My flight leaves at 14:35 and I want to be at the airport 2 hours before. The drive normally takes 50 minutes, but between 11:00 and 13:00 traffic makes it 30% longer. What's the latest I can leave home?",
        settleS: 8,
      },
    ],
    check: (i) => [...answeredInline(i, 0), ...matches(i.said, /11[:.]30/, "11:30"), ...noFiller(i.said)],
    rubric: `Correct answer: 11:30. Arrive by 12:35; a drive inside the 11:00-13:00 window takes 65 minutes, so leave at 11:30 (the whole drive falls in the window). Leaving at 11:45 with a 50-minute drive is wrong. Score 1 for a wrong time, 3 for right time with muddled reasoning, 5 for right time with one short line of reasoning. ${VOICE}`,
  },
  {
    id: "reason-schedule",
    row: "reasoning",
    about: "A constraint puzzle",
    steps: [
      {
        text: "Three meetings to fit into one afternoon from 13:00 to 17:00: A takes 90 minutes, B takes 60, C takes 45. B must end before A starts, C can't be right after B, and I need a 15-minute break between any two meetings. Give me a schedule that works.",
        settleS: 8,
      },
    ],
    check: (i) => [...answeredInline(i, 0), ...noFiller(i.said)],
    rubric: `A valid schedule: B is before A, C is not directly after B, 15-minute gaps between meetings, all within 13:00-17:00. The only valid order is C, B, A (B before A, C not right after B, so C can't sit between B and A): for example C 13:00-13:45, B 14:00-15:00, A 15:15-16:45. Check the answer yourself: score 1 for a schedule that breaks a rule, 5 for a valid one stated briefly. ${VOICE}`,
  },
  {
    id: "reason-schedule-task",
    row: "reasoning",
    about: "The same constraint puzzle, delegated, to compare a task's latency with an inline answer",
    steps: [
      {
        text: "Make it a task: three meetings to fit into one afternoon from 13:00 to 17:00: A takes 90 minutes, B takes 60, C takes 45. B must end before A starts, C can't be right after B, and I need a 15-minute break between any two meetings. Give me a schedule that works.",
        settleS: 20,
      },
    ],
    check: (i) => [...delegated(i), ...noFiller(i.said)],
    rubric: `A valid schedule: B is before A, C is not directly after B, 15-minute gaps between meetings, all within 13:00-17:00. The only valid order is C, B, A: for example C 13:00-13:45, B 14:00-15:00, A 15:15-16:45. Score the relayed result: 1 for a schedule that breaks a rule, 5 for a valid one stated briefly. ${VOICE}`,
  },
  {
    id: "task-simple",
    row: "simple-task",
    about: "A small lookup-and-summary task, delegated, with its result relayed",
    steps: [
      {
        text: "Make it a task: find the Louvre's opening hours and which day it's closed, and summarise them in two lines.",
        settleS: 20,
      },
    ],
    check: (i) => [
      ...delegated(i),
      ...matches(i.said, /tuesday|周二|星期二/i, "the closing day (Tuesday)"),
      ...noFiller(i.said),
    ],
    rubric: `The relayed result should give the Louvre's opening hours (around 9:00-18:00, with late opening on some evenings, e.g. Wednesday/Friday until 21:00) and say it is closed on Tuesdays, in about two lines. Score the final relayed result, not the hand-off line. ${VOICE}`,
  },
  {
    id: "task-heavy",
    row: "heavy-task",
    about: "A research and analysis task, delegated, with its result relayed",
    steps: [
      {
        text: "Make it a task: compare heat pump, gas condensing boiler and pellet heating for a 140 m² house in southern Germany built in 1995 — rough install cost, running cost per year, and subsidies available in 2026. Give me a recommendation.",
        settleS: 30,
      },
    ],
    check: (i) => [
      ...delegated(i),
      ...matches(i.said, /heat pump|wärmepumpe|热泵/i, "the heat pump"),
      ...matches(i.said, /€|eur/i, "costs in euros"),
    ],
    rubric: `The relayed result should compare the three systems on install cost, yearly running cost and 2026 subsidies (e.g. the German BEG/KfW heating subsidy for heat pumps and pellets, none or little for gas), with plausible numbers, and end in a clear recommendation with a reason. Judge the reasoning and plausibility, and whether the relay is a usable summary (3-6 sentences or a compact table) rather than a wall of text. ${VOICE}`,
  },
  {
    id: "recall",
    row: "recall",
    about: "A fact told early in the chat, asked for again later",
    steps: [
      { text: "FYI my sister Lena just moved to Porto, she starts at a design studio there next month.", settleS: 6 },
      { text: "What's a good gift for someone who just started a new job?", settleS: 6 },
      { text: "Which city did I say my sister moved to, and what's her new job?", settleS: 6 },
    ],
    check: (i) => [
      ...answeredInline(i, 2),
      ...matches(i.saidAfter[2] ?? [], /porto/i, "Porto"),
      ...matches(i.saidAfter[2] ?? [], /design/i, "the design studio"),
      ...noFiller(i.said),
    ],
    rubric: `The last answer must say Porto and a job at a design studio, in one line. The first reply should acknowledge the news briefly (a reaction or one line), and the gift answer should be short and practical. ${VOICE}`,
  },
];

/** Scenarios whose relay turn is the measurement of the relay row. */
export const RELAY_FROM = ["task-simple", "task-heavy"];
