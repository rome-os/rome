// The welcome-to-rome conversation as a state machine. Each user
// turn, `runTurn` reads the persisted node, decides what the turn should emit
// (a text block or one of the app's own inline components), advances the node,
// and returns it. Two intro branches:
//
//   • Import from ChatGPT — guide the guardian to open the Desktop browser,
//     drive the server Chrome to ChatGPT (CDP), wait for sign-in, scrape what
//     ChatGPT remembers. Zero-model.
//   • Answer questions — show the host's built-in ask_question card (a fixed
//     question set) and read the answers back.
//
// Both branches end the same way: fold the gathered text into memory by
// summoning `welcome-memory` INLINE (no child session/approval), then summon the
// idea specialist INLINE and show the idea picker → done. Everything the heavy
// steps need is a blocking `summon`; nothing hands off anymore. The middleware
// (index.ts) turns each reply into events; this file owns *what to show / ask,
// and when*.

import { copyFor, type CompletionProps, type WelcomeCopy } from "./copy.js";
import type { AppIdea, ProgressRepository } from "../../db/repositories/progress.js";
import { encodeIdeas } from "../../db/repositories/progress.js";
import { genericIdeas, introQuestionsFor } from "../../i18n/locales/index.js";
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
  | { kind: "ask"; lead?: string; questions: AskQuestion[] };

/** Result of driving ChatGPT in the server browser. */
export interface ChatGptScrape {
  ok: boolean;
  reply?: string;
  noMemory?: boolean;
  reason?: string;
}

/** Result of summoning a specialist agent inline (blocking). */
export interface SummonResult {
  ok: boolean;
  /** Validated structured output, e.g. `{ ideas: [...] }`. */
  output: unknown;
}

/** The side-effect / output port the state machine drives. Kept abstract so the
 *  machine is testable without the AgentSession or a live browser. */
export interface WelcomeEffects {
  progress: ProgressRepository;
  /** Read the guardian-chosen name for the main agent, falling back to Rome. */
  getAgentName(): Promise<string>;
  /** Read the guardian's selected Rome language. */
  getLocale(): Promise<WelcomeLocale>;
  /** Emit an intermediate narration block (commentary), typed out word by word.
   *  Resolves once the whole block has streamed, so callers `await` it to keep
   *  ordering against later emits. */
  say(text: string): Promise<void>;
  /** Run a specialist agent inline (no child session / approval) and return its
   *  structured output. Used for autonomous steps like the idea brainstorm. */
  summon(agentName: string, prompt: string): Promise<SummonResult>;
  chatgpt: {
    openTab(): Promise<void>;
    checkLogin(): Promise<{ loggedIn: boolean; reason: string }>;
    scrape(): Promise<ChatGptScrape>;
  };
  /** Send the onboarding "hello" email — a deterministic script step (no model),
   *  implemented over the `send_message` action. `to` is the guardian's address
   *  or the literal "guardian" (the email channel resolves it). */
  email: {
    send(to: string, subject: string, text: string): Promise<{ ok: boolean }>;
  };
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
// source text (a ChatGPT export, or the formatted questionnaire answers).
function memoryPrompt(source: string, locale: WelcomeLocale): string {
  return [
    "Here is what we just learned about the guardian. Fold the useful facts into",
    "their memory per your instructions, then return { summary } as the final structured result.",
    guardianLanguageInstruction(locale),
    "",
    source,
  ].join("\n");
}

/** Render the questionnaire answers into a readable block for the memory agent.
 *  Values are already strings (the ask_question card joins multi-select with
 *  ", "); blank/omitted answers simply don't appear. */
function formatAnswers(answers: Record<string, string>): string {
  const lines: string[] = [];
  if (answers.role) lines.push(`Role / field: ${answers.role}`);
  if (answers.interests) lines.push(`Interested in: ${answers.interests}`);
  if (answers.helpFirst) lines.push(`Wants help with first: ${answers.helpFirst}`);
  if (answers.commStyle) lines.push(`Preferred communication style: ${answers.commStyle}`);
  if (answers.anythingElse) lines.push(`Anything else: ${answers.anythingElse}`);
  return lines.join("\n");
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

/** The greeting (text) + the two-way intro choice component. */
/** The email handshake card (the first step): shows the agent's + guardian's
 *  addresses and an "agree & send" button. The card itself reads identity and
 *  provisions if needed (via core APIs); the script sends the hello on agree. */
async function emailHandshakeReply(
  fx: WelcomeEffects,
  language: WelcomeLanguage,
): Promise<TurnReply> {
  return {
    kind: "component",
    lead: language.copy.emailIntro(await fx.getAgentName()),
    componentId: "email-handshake",
    props: {},
  };
}

/** The "check your inbox" card shown after the hello is sent. */
function receiptReply(guardianEmail: string, language: WelcomeLanguage): TurnReply {
  return {
    kind: "component",
    lead: language.copy.emailSentLead,
    componentId: "email-receipt",
    props: { guardianEmail },
  };
}

function greetReply(language: WelcomeLanguage): TurnReply {
  return { kind: "component", lead: language.copy.greet, componentId: "intro-choice", props: {} };
}

/** The "open the browser, then continue" component (ChatGPT-import branch). */
function browserStep(notSignedIn = false): TurnReply {
  return { kind: "component", componentId: "browser-step", props: { notSignedIn } };
}

// Card submissions use stable English action codes; each locale also accepts
// natural-language input in the guardian's language.
const ACTION_PATTERNS_BY_LOCALE: Record<
  WelcomeLocale,
  { import: RegExp; answer: RegExp; skip: RegExp; none: RegExp; restart: RegExp }
> = {
  en: {
    import: /import|chatgpt/,
    answer: /answer|question/,
    skip: /skip/,
    none: /^(none|no|nope|skip|later|not now)\b/,
    restart: /\b(start over|restart|revisit|do (it|this) again|run again)\b/,
  },
  "zh-CN": {
    import: /import|chatgpt|导入/,
    answer: /answer|question|回答|问题|问答/,
    skip: /skip|跳过|暂不|以后/,
    none: /^(none|no|nope|skip|later|not now)\b|^(跳过|以后|暂不)/,
    restart: /\b(start over|restart|revisit|do (it|this) again|run again)\b|重新开始|再来一次|重来/,
  },
};

/** The fixed getting-to-know-you questionnaire (built-in ask_question card).
 *  Resolves next turn with `{ answers: [{ questionId, value }] }`. */
function introQuestions(language: WelcomeLanguage): TurnReply {
  return {
    kind: "ask",
    lead: language.copy.questionsLead,
    questions: introQuestionsFor(language.locale),
  };
}

/** The "pick your first app" buttons (the ideas themselves render above as a
 *  markdown text message). Each "Build this" opens a fresh chat client-side;
 *  only the explore opt-out resolves this turn. */
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

/** The completion component (closing message + copyable kickoff + revisit). */
function completionCard(props: CompletionProps): TurnReply {
  return { kind: "component", componentId: "completion-card", props: { ...props } };
}

const FRESH_PROGRESS = {
  introRawInput: null,
  introSummary: null,
  appIdeas: null,
  appIdeasGeneratedAt: null,
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
      // First contact: greet + the email handshake (the first onboarding step,
      // before getting-to-know-you). The kickoff message the user typed to open
      // the conversation is intentionally not consumed.
      fx.progress.patch({ node: "await_email" });
      return emailHandshakeReply(fx, language);
    }

    case "await_email": {
      // The handshake card resolves with `{ agreed, guardianEmail }` once the
      // guardian confirms, or `{ skip }` when email isn't available in this
      // environment (or they opt out). Skip / dismiss → straight to getting to
      // know you.
      const res = readResolutionJson(userText);
      if (res?.skip === true || isDismissedInteraction(userText)) {
        fx.progress.patch({ node: "await_choice" });
        return greetReply(language);
      }
      // Only an explicit `{ agreed: true }` from the card sends mail. Anything
      // else — free text like "why do I need this?", or a malformed resolution —
      // must not fire an email; re-show the handshake and wait for a real choice.
      if (res?.agreed !== true) {
        return emailHandshakeReply(fx, language);
      }
      // Agreed: send the hello (script, no model). On failure, don't pretend a
      // mail is coming — just move on.
      const to = field(userText, "guardianEmail") ?? "guardian";
      const agentName = await fx.getAgentName();
      const sent = await fx.email.send(
        to,
        language.copy.helloEmailSubject,
        language.copy.helloEmailBody(agentName),
      );
      if (!sent.ok) {
        fx.progress.patch({ node: "await_choice" });
        return greetReply(language);
      }
      fx.progress.patch({ node: "await_email_receipt" });
      return receiptReply(to, language);
    }

    case "await_email_receipt": {
      // The receipt card resolves with `{ received }` / `{ skip }` (both move on)
      // or `{ resend }` (send again, re-show the card). Confirming receipt is
      // optional — either button continues.
      const res = readResolutionJson(userText);
      if (res?.resend === true) {
        const to = field(userText, "guardianEmail") ?? "guardian";
        const agentName = await fx.getAgentName();
        await fx.email.send(
          to,
          language.copy.helloEmailSubject,
          language.copy.helloEmailBody(agentName),
        );
        return receiptReply(to, language);
      }
      fx.progress.patch({ node: "await_choice" });
      return greetReply(language);
    }

    case "await_choice": {
      const choice = field(userText, "choice") ?? normalize(userText);
      const patterns = ACTION_PATTERNS_BY_LOCALE[language.locale];
      if (patterns.import.test(choice)) {
        // Pre-open ChatGPT in the server Chrome so it's already showing when the
        // guardian opens the Browser widget. Best-effort.
        await fx.chatgpt.openTab().catch(() => {});
        fx.progress.patch({ node: "await_browser" });
        return browserStep();
      }
      if (patterns.answer.test(choice)) {
        fx.progress.patch({ node: "await_questions" });
        return introQuestions(language);
      }
      return greetReply(language);
    }

    case "await_browser": {
      const action = field(userText, "action") ?? normalize(userText);
      if (ACTION_PATTERNS_BY_LOCALE[language.locale].skip.test(action)) {
        fx.progress.patch({ node: "await_questions" });
        return introQuestions(language);
      }
      // "Continue": confirm sign-in, then scrape.
      const login = await fx.chatgpt.checkLogin();
      if (!login.loggedIn) {
        return browserStep(true);
      }
      await fx.say(language.copy.magicTrick);
      const scrape = await fx.chatgpt.scrape();
      if (scrape.ok && scrape.reply) {
        // Fold the export into memory inline, then continue in this same turn.
        fx.progress.patch({ introRawInput: scrape.reply });
        await foldMemory(fx, scrape.reply, language);
        return continueAfterMemory(fx, now, language);
      }
      // No memory stored, or the scrape failed — fall back to the questionnaire.
      await fx.say(scrape.noMemory ? language.copy.chatgptNoMemory : language.copy.chatgptFailed);
      fx.progress.patch({ node: "await_questions" });
      return introQuestions(language);
    }

    case "await_questions": {
      // The built-in question card resolves with `{ answers: [...] }`. A
      // dismissal means the guardian opted out — move on. But plain typed text
      // (they wrote in the composer instead of submitting the card) is NOT a
      // completed questionnaire: re-show the card and stay parked, so their
      // input isn't dropped and onboarding doesn't jump ahead.
      if (isDismissedInteraction(userText)) {
        return continueAfterMemory(fx, now, language);
      }
      const answers = readAnswers(userText);
      if (!answers) {
        return introQuestions(language);
      }
      // A real submission — fold the answers into memory inline (an all-blank
      // submit yields no source and just continues), then continue this turn.
      const source = formatAnswers(answers);
      if (source) {
        fx.progress.patch({ introRawInput: source });
        await foldMemory(fx, source, language);
      }
      return continueAfterMemory(fx, now, language);
    }

    case "await_scouts": {
      return brainstormAppIdeas(fx, now, language);
    }

    case "await_idea": {
      const ideas = p.ideas.length > 0 ? p.ideas : genericIdeas(language.locale);
      const idea = resolveChosenIdea(userText, ideas, language.locale);
      fx.progress.patch({ node: "done", completedAt: now() });
      return completionCard(idea ? language.copy.pickedIdea(idea) : language.copy.finishedNoPick);
    }

    case "done":
    default: {
      // The "run again" button (or a typed "start over") resets and re-greets.
      if (readResolutionJson(userText)?.revisit === true || isRestart(userText, language.locale)) {
        fx.progress.patch({ node: "await_choice", ...FRESH_PROGRESS });
        return greetReply(language);
      }
      return completionCard(language.copy.alreadyDone);
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

/** Shared tail of both intro branches: surface the memory takeaway, then either
 *  offer briefing scouts or go straight to the first-app brainstorm. Runs inline
 *  within the triggering turn (the memory fold already happened via summon). */
async function continueAfterMemory(
  fx: WelcomeEffects,
  now: () => string,
  language: WelcomeLanguage,
): Promise<TurnReply> {
  const current = fx.progress.get();
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

/** A typed request to run onboarding again (fallback for the revisit button). */
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
