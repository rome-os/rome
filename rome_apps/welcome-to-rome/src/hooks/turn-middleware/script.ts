// The welcome-to-rome conversation as a state machine. Each user
// turn, `runTurn` reads the persisted node, decides what the turn should emit
// (a text block, one of the app's own inline components, or a host card),
// advances the node, and returns it. The path is:
//
//   greet → await_names → await_ai → await_question → (await_scouts) → await_idea → done
//
// The script spends no tokens of its own, so it runs before any AI provider is
// connected. Two steps summon real agents: the memory fold after the question
// and the app-idea brainstorm. The connect-AI step comes before both, and a
// skipped connect keeps the raw answer for a later fold and shows the generic
// idea list instead of summoning. The middleware (index.ts) turns each reply
// into events; this file owns *what to show / ask, and when*.

import { copyFor, type WelcomeCopy } from "./copy.js";
import type { AppIdea, ProgressRepository } from "../../db/repositories/progress.js";
import { encodeIdeas } from "../../db/repositories/progress.js";
import { genericIdeas, introQuestionFor } from "../../i18n/locales/index.js";
import { guardianLanguageInstruction, type WelcomeLocale } from "../../locale.js";
import { isDismissedInteraction, readResolutionJson } from "./resolution.js";
import type { AskQuestion } from "./component.js";
import { scoutSuggestionsFromBasis, type ScoutSuggestion } from "./scout-suggestions.js";

const MEMORY_AGENT = "welcome-memory";
const IDEAS_AGENT = "welcome-app-ideas";

/** Idea-picker opt-out sentinel (must match src/web/idea-picker.tsx). */
const EXPLORE = "__explore__";

/** What one turn should emit. */
export type TurnReply =
  | { kind: "text"; text: string }
  // One of welcome-to-rome's own inline components; its result returns next turn.
  | { kind: "component"; lead?: string; componentId: string; props: Record<string, unknown> }
  // The host's built-in ask_question card; its answers return as the next turn.
  | { kind: "ask"; lead?: string; questions: AskQuestion[] }
  // The host's built-in connect-AI card; `{ connected }` or `{ skip }` returns next turn.
  | { kind: "connect_ai"; lead?: string };

/** Result of summoning a specialist agent inline (blocking). */
export interface SummonResult {
  ok: boolean;
  /** Validated structured output, e.g. `{ ideas: [...] }`. */
  output: unknown;
}

/** The side-effect / output port the state machine drives. Kept abstract so the
 *  machine is testable without the AgentSession. */
export interface WelcomeEffects {
  progress: ProgressRepository;
  /** Read the guardian-chosen name for the main agent, falling back to Rome. */
  getAgentName(): Promise<string>;
  /** Read the guardian's display name, or null when setup left none. */
  getGuardianName(): Promise<string | null>;
  /** Read the guardian's selected Rome language. */
  getLocale(): Promise<WelcomeLocale>;
  /** Write the two names through the host's profile path: settings and the
   *  guardian person row. The only write effect the script has. */
  writeNames(names: { guardianName: string; agentName: string }): Promise<{ ok: boolean }>;
  /** Emit an intermediate narration block (commentary), typed out word by word.
   *  Resolves once the whole block has streamed, so callers `await` it to keep
   *  ordering against later emits. */
  say(text: string): Promise<void>;
  /** Run a specialist agent inline (no child session / approval) and return its
   *  structured output. Used for autonomous steps like the idea brainstorm. */
  summon(agentName: string, prompt: string): Promise<SummonResult>;
}

interface WelcomeLanguage {
  locale: WelcomeLocale;
  copy: WelcomeCopy;
}

function ideasFromSummon(output: unknown): AppIdea[] {
  const raw =
    output && typeof output === "object" ? (output as Record<string, unknown>).ideas : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) =>
    item &&
    typeof item === "object" &&
    typeof (item as AppIdea).title === "string" &&
    typeof (item as AppIdea).prompt === "string"
      ? [{ title: (item as AppIdea).title, prompt: (item as AppIdea).prompt }]
      : [],
  );
}

// The summon prompt fed to `welcome-memory`. Its system prompt already carries
// the full fold-into-memory instructions, so this just frames + carries the
// source text (the formatted answer).
function memoryPrompt(source: string, locale: WelcomeLocale): string {
  return [
    "Here is what we just learned about the guardian. Fold the useful facts into",
    "their memory per your instructions, then return { summary } as the final structured result.",
    guardianLanguageInstruction(locale),
    "",
    source,
  ].join("\n");
}

/** Render the answer into a readable line for the memory agent. A blank
 *  answer yields an empty string. */
function formatAnswers(answers: Record<string, string>): string {
  return answers.helpFirst ? `Wants help with first: ${answers.helpFirst}` : "";
}

function ideasBrief(basis: string, locale: WelcomeLocale): string {
  return [
    "Brainstorming your first apps to build.",
    "",
    "From what Rome learned about the guardian below, brainstorm a few concrete, personalized first apps, then return the idea tuples as the final structured result.",
    guardianLanguageInstruction(locale),
    "",
    basis,
  ].join("\n");
}

/** The greeting plus the name-confirmation card, prefilled from settings. */
async function namesReply(fx: WelcomeEffects, language: WelcomeLanguage): Promise<TurnReply> {
  const agentName = await fx.getAgentName();
  const guardianName = (await fx.getGuardianName()) ?? "";
  return {
    kind: "component",
    lead: language.copy.greet(guardianName, agentName),
    componentId: "name-card",
    props: { guardianName, agentName },
  };
}

function connectAiReply(language: WelcomeLanguage): TurnReply {
  return { kind: "connect_ai", lead: language.copy.connectAiLead };
}

// Typed requests use stable English words; each locale also accepts
// natural-language input in the guardian's language.
const ACTION_PATTERNS_BY_LOCALE: Record<WelcomeLocale, { none: RegExp; restart: RegExp }> = {
  en: {
    none: /^(none|no|nope|skip|later|not now)\b/,
    restart: /\b(start over|restart|revisit|do (it|this) again|run again)\b/,
  },
  "zh-CN": {
    none: /^(none|no|nope|skip|later|not now)\b|^(跳过|以后|暂不)/,
    restart: /\b(start over|restart|revisit|do (it|this) again|run again)\b|重新开始|再来一次|重来/,
  },
};

/** The one getting-to-know-you question (built-in ask_question card).
 *  Resolves next turn with `{ answers: [{ questionId, value }] }`. */
function introQuestion(language: WelcomeLanguage): TurnReply {
  return {
    kind: "ask",
    lead: language.copy.questionLead,
    questions: [introQuestionFor(language.locale)],
  };
}

/** The "pick your first app" buttons. Each "Build this" resolves this turn and
 *  opens a fresh chat client-side with the prompt in the composer; the explore
 *  opt-out resolves with the EXPLORE sentinel and opens an empty chat. */
function ideaPicker(ideas: AppIdea[]): TurnReply {
  return { kind: "component", componentId: "idea-picker", props: { ideas } };
}

function scoutSuggestions(scouts: ScoutSuggestion[], language: WelcomeLanguage): TurnReply {
  return {
    kind: "component",
    lead: language.copy.scoutsLead,
    componentId: "scout-suggestions",
    props: { scouts },
  };
}

const FRESH_PROGRESS = {
  introRawInput: null,
  introSummary: null,
  appIdeas: null,
  appIdeasGeneratedAt: null,
  aiConnected: null,
  completedAt: null,
} as const;

/** Read a string field from a resolved component's submitted output. */
function field(userText: string, key: string): string | null {
  const v = readResolutionJson(userText)?.[key];
  return typeof v === "string" ? v : null;
}

/**
 * Run one user turn through the state machine. Returns what the turn should emit;
 * the caller (index.ts) turns it into events.
 */
export async function runTurn(userText: string, fx: WelcomeEffects): Promise<TurnReply> {
  const p = fx.progress.get();
  const locale = await fx.getLocale();
  const language: WelcomeLanguage = { locale, copy: copyFor(locale) };
  const now = () => new Date().toISOString();

  switch (p.node) {
    case "greet": {
      // First contact: greet by name and confirm the two names. The kickoff
      // message the user typed to open the conversation is not consumed.
      fx.progress.patch({ node: "await_names" });
      return namesReply(fx, language);
    }

    case "await_names": {
      // The name card resolves with `{ guardianName, agentName }`. A dismissal
      // keeps the prefilled names. Free text (typed in the composer instead of
      // the card) re-shows the card and stays parked.
      const res = readResolutionJson(userText);
      if (!res && !isDismissedInteraction(userText)) {
        return namesReply(fx, language);
      }
      const guardianName = field(userText, "guardianName")?.trim() || (await fx.getGuardianName());
      const agentName = field(userText, "agentName")?.trim() || (await fx.getAgentName());
      if (guardianName) {
        await fx.writeNames({ guardianName, agentName });
      }
      fx.progress.patch({ node: "await_ai" });
      return connectAiReply(language);
    }

    case "await_ai": {
      // The host card resolves with `{ connected: true }` once the status probe
      // reports a provider logged in, or `{ skip: true }`. A dismissal counts as
      // a skip. Free text re-shows the card and stays parked, which is also how
      // a return from the Codex browser login lands back on this step.
      const res = readResolutionJson(userText);
      if (!res && !isDismissedInteraction(userText)) {
        return connectAiReply(language);
      }
      fx.progress.patch({ node: "await_question", aiConnected: res?.connected === true });
      return introQuestion(language);
    }

    case "await_question": {
      // The built-in question card resolves with `{ answers: [...] }`. A
      // dismissal means the guardian opted out — move on. Plain typed text is
      // NOT an answer: re-show the card and stay parked.
      if (isDismissedInteraction(userText)) {
        return continueAfterQuestion(fx, now, language);
      }
      const answers = readAnswers(userText);
      if (!answers) {
        return introQuestion(language);
      }
      const source = formatAnswers(answers);
      if (source) {
        fx.progress.patch({ introRawInput: source });
        if (p.aiConnected) await foldMemory(fx, source, language);
      }
      return continueAfterQuestion(fx, now, language);
    }

    case "await_scouts": {
      return brainstormAppIdeas(fx, now, language);
    }

    case "await_idea": {
      const ideas = p.ideas.length > 0 ? p.ideas : genericIdeas(language.locale);
      const idea = resolveChosenIdea(userText, ideas, language.locale);
      fx.progress.patch({ node: "done", completedAt: now() });
      return {
        kind: "text",
        text: idea ? language.copy.pickedIdea(idea) : language.copy.finishedNoPick,
      };
    }

    case "done":
    default: {
      // A typed "start over" resets and re-greets.
      if (isRestart(userText, language.locale)) {
        fx.progress.patch({ node: "await_names", ...FRESH_PROGRESS });
        return namesReply(fx, language);
      }
      return { kind: "text", text: language.copy.alreadyDone };
    }
  }
}

/** Read the built-in ask_question answers (`{ answers: [{ questionId, value }] }`)
 *  from a resolution turn into a `{ [questionId]: value }` map. */
function readAnswers(userText: string): Record<string, string> | null {
  const raw = readResolutionJson(userText)?.answers;
  if (!Array.isArray(raw)) return null;
  const map: Record<string, string> = {};
  for (const a of raw) {
    if (a && typeof a === "object") {
      const id = (a as Record<string, unknown>).questionId;
      const value = (a as Record<string, unknown>).value;
      if (typeof id === "string" && typeof value === "string") map[id] = value;
    }
  }
  return map;
}

/** Pull the `{ summary }` string out of a `welcome-memory` summon's output. */
function summaryFromSummon(output: unknown): string | null {
  const s =
    output && typeof output === "object" ? (output as Record<string, unknown>).summary : null;
  return typeof s === "string" ? s : null;
}

/** Fold `source` into the guardian's memory by summoning `welcome-memory` INLINE
 *  (no child session/approval), narrating the brief wait. The summon writes the
 *  memory files itself; we keep its returned summary for the takeaway. Best
 *  effort — a failed summon just leaves `introSummary` unset and the brainstorm
 *  falls back to the raw input. */
async function foldMemory(
  fx: WelcomeEffects,
  source: string,
  language: WelcomeLanguage,
): Promise<void> {
  await fx.say(language.copy.savingMemoryLead);
  const summoned = await fx.summon(MEMORY_AGENT, memoryPrompt(source, language.locale));
  const summary = summoned.ok ? summaryFromSummon(summoned.output) : null;
  if (summary) fx.progress.patch({ introSummary: summary });
}

/** Shared tail of the question step. With an AI connected: surface the memory
 *  takeaway, then either offer briefing scouts or go straight to the first-app
 *  brainstorm. Without one, the scouts (which need a model to run) and the
 *  brainstorm are skipped for the static idea list. */
async function continueAfterQuestion(
  fx: WelcomeEffects,
  now: () => string,
  language: WelcomeLanguage,
): Promise<TurnReply> {
  const current = fx.progress.get();
  if (!current.aiConnected) {
    return staticIdeas(fx, now, language);
  }
  // Surface what we learned as a normal assistant text block (markdown), not a
  // bordered card inside the picker.
  const takeaway = current.introSummary;
  if (takeaway) await fx.say(language.copy.takeaway(takeaway));

  const basis = takeaway ?? current.introRawInput ?? "";
  const scouts = scoutSuggestionsFromBasis(basis, language.locale);
  if (scouts.length > 0) {
    fx.progress.patch({ node: "await_scouts" });
    return scoutSuggestions(scouts, language);
  }
  return brainstormAppIdeas(fx, now, language);
}

async function staticIdeas(
  fx: WelcomeEffects,
  now: () => string,
  language: WelcomeLanguage,
): Promise<TurnReply> {
  const ideas = genericIdeas(language.locale);
  fx.progress.patch({
    node: "await_idea",
    appIdeas: encodeIdeas(ideas),
    appIdeasGeneratedAt: now(),
  });
  await fx.say(language.copy.ideasOffline);
  return ideaPicker(ideas);
}

async function brainstormAppIdeas(
  fx: WelcomeEffects,
  now: () => string,
  language: WelcomeLanguage,
): Promise<TurnReply> {
  const current = fx.progress.get();
  await fx.say(language.copy.ideasHandoffLead);

  // The brainstorm is autonomous and its real "approval" is the idea picker
  // below (the guardian picks one), so summon the specialist INLINE rather
  // than handing off — no child session, no submit-result gate.
  const basis = current.introSummary ?? current.introRawInput ?? "";
  const summoned = await fx.summon(IDEAS_AGENT, ideasBrief(basis, language.locale));
  let ideas = summoned.ok ? ideasFromSummon(summoned.output) : [];
  const usedFallback = ideas.length === 0;
  if (usedFallback) ideas = genericIdeas(language.locale);

  fx.progress.patch({
    node: "await_idea",
    appIdeas: encodeIdeas(ideas),
    appIdeasGeneratedAt: now(),
  });
  if (usedFallback) await fx.say(language.copy.ideasFailed);
  return ideaPicker(ideas);
}

/** Resolve which idea the guardian chose from the idea-picker's output (or, as a
 *  fallback, typed text). Returns undefined for the explore opt-out / no match. */
function resolveChosenIdea(
  userText: string,
  ideas: AppIdea[],
  locale: WelcomeLocale,
): AppIdea | undefined {
  if (isDismissedInteraction(userText)) return undefined;

  const chosen = field(userText, "ideaTitle");
  if (chosen) {
    if (chosen === EXPLORE) return undefined;
    return ideas.find((idea) => idea.title === chosen);
  }

  // Typed fallback: accept a number or a title mention.
  if (isNone(userText, locale)) return undefined;
  const pick = parsePick(userText, ideas.length);
  if (pick !== null) return ideas[pick];
  const lower = normalize(userText);
  return ideas.find((idea) => lower.includes(idea.title.toLowerCase()));
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isNone(text: string, locale: WelcomeLocale): boolean {
  return ACTION_PATTERNS_BY_LOCALE[locale].none.test(normalize(text));
}

/** A typed request to run onboarding again. */
function isRestart(text: string, locale: WelcomeLocale): boolean {
  return ACTION_PATTERNS_BY_LOCALE[locale].restart.test(normalize(text));
}

/** Parse a 1-based idea choice into a 0-based index, or null. */
function parsePick(text: string, count: number): number | null {
  const match = normalize(text).match(/\b(\d{1,2})\b/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  return n - 1;
}
