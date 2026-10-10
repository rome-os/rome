import type { AppIdea } from "../../db/repositories/progress.js";
import type { AskQuestion } from "../../hooks/turn-middleware/component.js";
import { normalizeWelcomeLocale, type WelcomeLocale } from "../../locale.js";
import en from "./en.js";
import zhCN from "./zh-CN.js";

// Both locale modules must have the same shape. They keep all guardian-facing
// copy in one place per locale; this module only selects it and handles templates.
const MESSAGES_BY_LOCALE: Record<WelcomeLocale, typeof en> = {
  en,
  "zh-CN": zhCN,
};

export type WelcomeMessages = typeof en;

export function messagesFor(locale: unknown): WelcomeMessages {
  return MESSAGES_BY_LOCALE[normalizeWelcomeLocale(locale)];
}

export function formatMessage(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
    template,
  );
}

// Generic starter ideas, used when the brainstorm specialist is unavailable or
// hands back nothing usable — onboarding should still hand the guardian a first win.
export function genericIdeas(locale: WelcomeLocale): AppIdea[] {
  return messagesFor(locale).genericIdeas;
}

// The one getting-to-know-you question, shown as the host's built-in
// ask_question card (tap-to-answer with a free-text box). Role, interests, and
// tone are learned from use. The answer returns next turn as
// `{ answers: [{ questionId, value }] }`.
export function introQuestionFor(locale: WelcomeLocale): AskQuestion {
  return messagesFor(locale).introQuestion as AskQuestion;
}
